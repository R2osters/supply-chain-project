"""End-to-end checks over the HTTP surface.

Every endpoint is exercised through FastAPI's TestClient, which runs the real app: validation,
serialisation and the engines. The assertions that matter most are the invariants the brief
demands — an explanation on every response, and no recommendation without reasons.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture(scope="module", autouse=True)
def disable_auth():
    settings = get_settings()
    original = settings.require_auth
    settings.require_auth = False
    yield
    settings.require_auth = original


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def synthetic_history(days: int = 400, seed: int = 11) -> list[dict]:
    """Trend plus weekly seasonality plus noise — the shape real distribution demand takes."""
    rng = np.random.default_rng(seed)
    start = dt.date.today() - dt.timedelta(days=days)
    history = []
    for index in range(days):
        day = start + dt.timedelta(days=index)
        weekly = 1.0 + 0.3 * np.sin(2 * np.pi * day.weekday() / 7)
        level = 120 + 0.05 * index
        history.append(
            {
                "date": day.isoformat(),
                "quantity": round(float(max(0.0, level * weekly + rng.normal(0, 8))), 2),
            }
        )
    return history


def assert_explained(payload: dict) -> None:
    """The rule from the brief: never return a recommendation without justification."""
    explanation = payload.get("explanation")
    assert explanation, "response has no explanation block"
    assert explanation["summary"], "explanation has no summary"
    assert explanation["reasons"], "explanation has no reasons"
    assert isinstance(explanation["assumptions"], list)


class TestHealth:
    def test_reports_every_engine(self, client: TestClient):
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        for engine in ("forecasting", "allocation", "routing", "risk", "recommendations"):
            assert engine in body["engines"]


class TestForecast:
    def test_produces_an_explained_forecast(self, client: TestClient):
        response = client.post(
            "/forecast",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "history": synthetic_history(),
                "horizonDays": 30,
            },
        )
        assert response.status_code == 200
        body = response.json()

        assert len(body["forecast"]) == 30
        assert body["selectedModel"] in {
            "NAIVE",
            "SEASONAL_NAIVE",
            "MOVING_AVERAGE",
            "EXPONENTIAL_SMOOTHING",
            "HOLT_WINTERS",
            "GRADIENT_BOOSTING",
        }
        assert body["dataQuality"]["passed"] is True
        assert_explained(body)

    def test_bounds_bracket_the_point_estimate_and_widen(self, client: TestClient):
        response = client.post(
            "/forecast",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "history": synthetic_history(),
                "horizonDays": 30,
            },
        )
        points = response.json()["forecast"]

        for point in points:
            assert point["lowerBound"] <= point["demand"] <= point["upperBound"]
            assert point["lowerBound"] >= 0  # negative demand is not a thing

        first_width = points[0]["upperBound"] - points[0]["lowerBound"]
        last_width = points[-1]["upperBound"] - points[-1]["lowerBound"]
        assert last_width > first_width, "uncertainty must grow with the horizon"

    def test_compares_several_models_and_marks_one_selected(self, client: TestClient):
        body = client.post(
            "/forecast",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "history": synthetic_history(),
                "horizonDays": 7,
            },
        ).json()

        evaluated = [e for e in body["evaluations"] if e.get("skippedReason") is None]
        assert len(evaluated) >= 3, "the comparison must actually compare"
        assert sum(1 for e in body["evaluations"] if e["selected"]) == 1

    def test_refuses_to_forecast_from_unusable_history(self, client: TestClient):
        response = client.post(
            "/forecast",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "history": [{"date": "2026-01-01", "quantity": 5}],
                "horizonDays": 7,
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["dataQuality"]["passed"] is False
        assert any(i["severity"] == "BLOCKING" for i in detail["dataQuality"]["issues"])


class TestInventory:
    def test_recommends_an_order_when_stock_is_short(self, client: TestClient):
        body = client.post(
            "/inventory/optimize",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "currentStock": 300,
                "averageDailyDemand": 100,
                "demandStdDev": 20,
                "leadTimeDays": 7,
                "leadTimeStdDevDays": 2,
                "serviceLevel": 0.95,
                "unitCost": 10,
                "orderingCost": 250,
            },
        ).json()

        assert body["reorderRequired"] is True
        assert body["recommendedOrderQuantity"] > 0
        assert body["safetyStock"] > 0
        assert body["economicOrderQuantity"] is not None
        assert_explained(body)

    def test_holds_off_when_the_position_is_healthy(self, client: TestClient):
        body = client.post(
            "/inventory/optimize",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "currentStock": 50_000,
                "averageDailyDemand": 100,
                "demandStdDev": 20,
                "leadTimeDays": 7,
                "leadTimeStdDevDays": 1,
            },
        ).json()

        assert body["reorderRequired"] is False
        assert body["recommendedOrderQuantity"] == 0
        assert body["stockoutProbability"] < 0.01

    def test_a_higher_service_level_costs_more_buffer(self, client: TestClient):
        def buffer_for(service_level: float) -> float:
            return client.post(
                "/inventory/optimize",
                json={
                    "productId": "p1",
                    "sku": "SKU-001",
                    "currentStock": 1000,
                    "averageDailyDemand": 100,
                    "demandStdDev": 30,
                    "leadTimeDays": 7,
                    "leadTimeStdDevDays": 2,
                    "serviceLevel": service_level,
                },
            ).json()["safetyStock"]

        assert buffer_for(0.99) > buffer_for(0.95) > buffer_for(0.90)

    def test_lead_time_variability_drives_the_buffer(self, client: TestClient):
        def buffer_for(lead_time_std: float) -> float:
            return client.post(
                "/inventory/optimize",
                json={
                    "productId": "p1",
                    "sku": "SKU-001",
                    "currentStock": 1000,
                    "averageDailyDemand": 100,
                    "demandStdDev": 10,
                    "leadTimeDays": 7,
                    "leadTimeStdDevDays": lead_time_std,
                },
            ).json()["safetyStock"]

        # An erratic supplier should demand far more buffer than a punctual one.
        assert buffer_for(4) > 3 * buffer_for(0)

    def test_rejects_reserving_more_than_is_on_hand(self, client: TestClient):
        response = client.post(
            "/inventory/optimize",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "currentStock": 100,
                "reservedStock": 500,
                "averageDailyDemand": 10,
                "demandStdDev": 2,
                "leadTimeDays": 5,
            },
        )
        assert response.status_code == 422


class TestSupplierScoring:
    def test_ranks_and_explains_every_candidate(self, client: TestClient):
        body = client.post(
            "/supplier/score",
            json={
                "suppliers": [
                    {
                        "supplierId": "A",
                        "name": "Supplier A",
                        "unitPrice": 10,
                        "leadTimeDays": 5,
                        "onTimeDeliveryRate": 0.92,
                        "capacityUnits": 20000,
                    },
                    {
                        "supplierId": "B",
                        "name": "Supplier B",
                        "unitPrice": 8,
                        "leadTimeDays": 12,
                        "onTimeDeliveryRate": 0.75,
                        "capacityUnits": 20000,
                    },
                    {
                        "supplierId": "C",
                        "name": "Supplier C",
                        "unitPrice": 11,
                        "leadTimeDays": 3,
                        "onTimeDeliveryRate": 0.97,
                        "capacityUnits": 20000,
                    },
                ]
            },
        ).json()

        assert [r["rank"] for r in body["results"]] == [1, 2, 3]
        assert body["results"][0]["score"] >= body["results"][-1]["score"]
        for result in body["results"]:
            assert result["explanation"]["reasons"]
        assert_explained(body)

    def test_weights_change_the_winner(self, client: TestClient):
        suppliers = [
            {
                "supplierId": "cheap",
                "name": "Cheap and slow",
                "unitPrice": 5,
                "leadTimeDays": 20,
                "onTimeDeliveryRate": 0.7,
                "capacityUnits": 10000,
            },
            {
                "supplierId": "fast",
                "name": "Dear and fast",
                "unitPrice": 15,
                "leadTimeDays": 2,
                "onTimeDeliveryRate": 0.99,
                "capacityUnits": 10000,
            },
        ]

        price_led = client.post(
            "/supplier/score",
            json={
                "suppliers": suppliers,
                "weights": {
                    "price": 0.9,
                    "reliability": 0.02,
                    "leadTime": 0.02,
                    "quality": 0.02,
                    "capacity": 0.02,
                    "distance": 0.02,
                },
            },
        ).json()
        speed_led = client.post(
            "/supplier/score",
            json={
                "suppliers": suppliers,
                "weights": {
                    "price": 0.02,
                    "reliability": 0.02,
                    "leadTime": 0.9,
                    "quality": 0.02,
                    "capacity": 0.02,
                    "distance": 0.02,
                },
            },
        ).json()

        assert price_led["results"][0]["supplierId"] == "cheap"
        assert speed_led["results"][0]["supplierId"] == "fast"


class TestAllocationEndpoint:
    def test_solves_the_worked_example(self, client: TestClient):
        body = client.post(
            "/supplier/allocation",
            json={
                "demandQuantity": 20000,
                "suppliers": [
                    {
                        "supplierId": "A",
                        "name": "Supplier A",
                        "unitPrice": 10,
                        "leadTimeDays": 5,
                        "onTimeDeliveryRate": 0.92,
                        "capacityUnits": 12000,
                    },
                    {
                        "supplierId": "B",
                        "name": "Supplier B",
                        "unitPrice": 8,
                        "leadTimeDays": 12,
                        "onTimeDeliveryRate": 0.75,
                        "capacityUnits": 15000,
                        "minimumOrderQuantity": 4000,
                    },
                    {
                        "supplierId": "C",
                        "name": "Supplier C",
                        "unitPrice": 11,
                        "leadTimeDays": 3,
                        "onTimeDeliveryRate": 0.97,
                        "capacityUnits": 10000,
                    },
                ],
                "requiredWithinDays": 7,
                "maxSupplierSharePercent": 0.5,
            },
        ).json()

        assert body["status"] == "OPTIMAL"
        assert sum(line["quantity"] for line in body["lines"]) == pytest.approx(20000, abs=1)
        assert max(line["sharePercent"] for line in body["lines"]) <= 50.0 + 1e-6
        assert_explained(body)


class TestDelay:
    def test_scores_a_benign_shipment_near_the_base_rate(self, client: TestClient):
        body = client.post(
            "/predict-delay",
            json={
                "distanceKm": 0,
                "plannedDurationHours": 4,
                "carrierOnTimeRate": 1.0,
                "departureHour": 9,
                "departureDayOfWeek": 2,
            },
        ).json()

        assert body["delayProbability"] == pytest.approx(0.18, abs=0.02)
        assert body["risk"] == "LOW"
        assert_explained(body)

    def test_a_poor_carrier_and_bad_conditions_raise_the_risk(self, client: TestClient):
        body = client.post(
            "/predict-delay",
            json={
                "distanceKm": 1500,
                "plannedDurationHours": 30,
                "carrierOnTimeRate": 0.55,
                "trafficCongestion": 0.8,
                "weatherSeverity": 0.7,
                "departureHour": 22,
                "departureDayOfWeek": 6,
                "routeIncidentRate": 8,
            },
        ).json()

        assert body["delayProbability"] > 0.7
        assert body["risk"] == "HIGH"
        # The attribution must name the carrier as the dominant factor.
        assert body["featureContributions"][0]["contribution"] > 0

    def test_falls_back_to_the_scorecard_when_history_is_too_small(self, client: TestClient):
        body = client.post(
            "/predict-delay",
            json={
                "distanceKm": 400,
                "plannedDurationHours": 8,
                "carrierOnTimeRate": 0.9,
                "trainingHistory": [
                    {"distanceKm": 400, "plannedDurationHours": 8, "carrierOnTimeRate": 0.9, "wasLate": False}
                ],
            },
        ).json()

        assert body["model"]["name"] == "delay-scorecard"
        assert "au moins" in body["explanation"]["reasons"][0]


class TestAnomaly:
    def _track(self, minutes: list[int], speeds: list[float], lat: float = 5.6, lng: float = -0.19):
        base = dt.datetime(2026, 6, 1, 8, 0, 0)
        return [
            {
                "latitude": lat + index * 0.01,
                "longitude": lng + index * 0.01,
                "speedKmh": speed,
                "recordedAt": (base + dt.timedelta(minutes=minute)).isoformat(),
            }
            for index, (minute, speed) in enumerate(zip(minutes, speeds))
        ]

    def test_finds_nothing_on_a_clean_track(self, client: TestClient):
        body = client.post(
            "/detect-anomaly",
            json={
                "shipmentId": "s1",
                "positions": self._track([0, 10, 20, 30, 40], [60, 62, 58, 61, 59]),
            },
        ).json()

        assert body["anomalies"] == []
        assert_explained(body)

    def test_flags_a_prolonged_stop(self, client: TestClient):
        body = client.post(
            "/detect-anomaly",
            json={
                "shipmentId": "s1",
                "positions": self._track(
                    [0, 10, 70, 130, 140], [60, 0, 0, 0, 55]
                ),
                "stopToleranceMinutes": 45,
            },
        ).json()

        types = [a["type"] for a in body["anomalies"]]
        assert "PROLONGED_STOP" in types

    def test_flags_a_route_deviation_once_not_per_fix(self, client: TestClient):
        # Corridor runs due east; the track wanders far north of it.
        body = client.post(
            "/detect-anomaly",
            json={
                "shipmentId": "s1",
                "positions": [
                    {"latitude": 5.6, "longitude": -0.19, "speedKmh": 60, "recordedAt": "2026-06-01T08:00:00"},
                    {"latitude": 6.4, "longitude": -0.10, "speedKmh": 60, "recordedAt": "2026-06-01T09:00:00"},
                    {"latitude": 6.5, "longitude": 0.00, "speedKmh": 60, "recordedAt": "2026-06-01T10:00:00"},
                ],
                "plannedRoute": [
                    {"latitude": 5.6, "longitude": -0.19},
                    {"latitude": 5.6, "longitude": 0.60},
                ],
                "corridorToleranceMeters": 2000,
            },
        ).json()

        deviations = [a for a in body["anomalies"] if a["type"] == "ROUTE_DEVIATION"]
        assert len(deviations) == 1, "one alert for the worst point, not one per off-corridor fix"
        assert deviations[0]["evidence"]["maxDeviationM"] > 2000

    def test_flags_a_gps_gap(self, client: TestClient):
        body = client.post(
            "/detect-anomaly",
            json={
                "shipmentId": "s1",
                "positions": self._track([0, 10, 200, 210], [60, 60, 60, 60]),
                "gpsGapToleranceMinutes": 30,
            },
        ).json()

        assert any(a["type"] == "GPS_LOSS" for a in body["anomalies"])

    def test_ignores_a_single_noisy_speed_reading(self, client: TestClient):
        body = client.post(
            "/detect-anomaly",
            json={
                "shipmentId": "s1",
                "positions": self._track([0, 10, 20, 30], [60, 200, 62, 59]),
                "expectedMaxSpeedKmh": 110,
            },
        ).json()

        assert not any(a["type"] == "ABNORMAL_SPEED" for a in body["anomalies"])


class TestRouting:
    def _stops(self, count: int) -> list[dict]:
        return [
            {
                "id": f"c{i}",
                "name": f"Client {i}",
                "location": {"latitude": 5.6 + 0.05 * i, "longitude": -0.19 + 0.04 * i},
                "demandUnits": 100,
            }
            for i in range(count)
        ]

    def test_plans_routes_for_twenty_customers_and_five_vehicles(self, client: TestClient):
        body = client.post(
            "/route/optimize",
            json={
                "depot": {"latitude": 5.6, "longitude": -0.19},
                "stops": self._stops(20),
                "vehicles": [
                    {
                        "id": f"v{i}",
                        "name": f"Truck {i}",
                        "capacityUnits": 600,
                        "costPerKm": 0.9,
                    }
                    for i in range(5)
                ],
                "solverTimeLimitSeconds": 5,
            },
        ).json()

        assert body["status"] == "FEASIBLE"
        assert body["unassignedStops"] == []
        assert body["totalDistanceKm"] > 0
        assert_explained(body)

        # Capacity must hold on every route.
        for route in body["routes"]:
            assert route["loadUnits"] <= 600 + 1e-6

    def test_leaves_stops_unassigned_rather_than_failing_when_capacity_is_short(
        self, client: TestClient
    ):
        body = client.post(
            "/route/optimize",
            json={
                "depot": {"latitude": 5.6, "longitude": -0.19},
                "stops": self._stops(10),
                "vehicles": [
                    {"id": "v0", "name": "Small van", "capacityUnits": 250, "costPerKm": 0.9}
                ],
                "solverTimeLimitSeconds": 5,
            },
        ).json()

        assert body["status"] == "FEASIBLE"
        assert len(body["unassignedStops"]) > 0
        assert any("Impossible de desservir" in reason for reason in body["explanation"]["reasons"])


class TestScenario:
    def test_produces_three_ordered_cases(self, client: TestClient):
        body = client.post(
            "/scenario/simulate",
            json={
                "productId": "p1",
                "sku": "SKU-001",
                "horizonDays": 60,
                "baseline": {
                    "averageDailyDemand": 100,
                    "demandStdDev": 25,
                    "currentStock": 2000,
                    "unitCost": 10,
                    "leadTimeDays": 7,
                    "leadTimeStdDevDays": 2,
                },
                "levers": {"demandChangePercent": 0.2, "supplierDelayDays": 3},
                "iterations": 500,
            },
        ).json()

        names = [case["name"] for case in body["cases"]]
        assert names == ["BASE_CASE", "BEST_CASE", "WORST_CASE"]

        base = body["cases"][0]
        best = body["cases"][1]
        worst = body["cases"][2]

        assert worst["stockoutRisk"] >= base["stockoutRisk"] >= best["stockoutRisk"]
        assert base["totalCostP05"] <= base["totalCost"] <= base["totalCostP95"]
        assert_explained(body)

    def test_is_reproducible_for_the_same_seed(self, client: TestClient):
        payload = {
            "productId": "p1",
            "sku": "SKU-001",
            "horizonDays": 30,
            "baseline": {
                "averageDailyDemand": 50,
                "demandStdDev": 15,
                "currentStock": 800,
                "unitCost": 10,
                "leadTimeDays": 5,
                "leadTimeStdDevDays": 1,
            },
            "iterations": 300,
            "randomSeed": 7,
        }

        first = client.post("/scenario/simulate", json=payload).json()
        second = client.post("/scenario/simulate", json=payload).json()

        assert first["cases"][0]["totalCost"] == second["cases"][0]["totalCost"]


class TestRiskAndRecommendations:
    def _company(self) -> dict:
        return {
            "companyId": "co1",
            "products": [
                {
                    "productId": "p1",
                    "sku": "SKU-001",
                    "currentStock": 300,
                    "averageDailyDemand": 100,
                    "demandStdDev": 30,
                    "leadTimeDays": 7,
                    "leadTimeStdDevDays": 2,
                    "unitCost": 12,
                    "incomingQuantity": 0,
                },
                {
                    "productId": "p2",
                    "sku": "SKU-002",
                    "currentStock": 60_000,
                    "averageDailyDemand": 100,
                    "demandStdDev": 10,
                    "leadTimeDays": 5,
                    "unitCost": 8,
                },
            ],
            "suppliers": [
                {
                    "supplierId": "s1",
                    "name": "Dominant but shaky",
                    "onTimeDeliveryRate": 0.62,
                    "qualityAcceptanceRate": 0.9,
                    "sharePercent": 0.8,
                    "country": "GH",
                    "leadTimeStdDevDays": 5,
                    "unitPrice": 10,
                    "leadTimeDays": 7,
                    "capacityUnits": 50_000,
                    "productIds": ["p1"],
                }
            ],
            "shipments": [
                {
                    "shipmentId": "sh1",
                    "trackingNumber": "SHP-1",
                    "delayProbability": 0.8,
                    "valueAtRisk": 25_000,
                    "productIds": ["p1"],
                }
            ],
        }

    def test_risk_analysis_scores_health_and_ranks_findings(self, client: TestClient):
        body = client.post("/risk/analyze", json=self._company()).json()

        assert 0 <= body["supplyChainHealthScore"] <= 100
        assert body["findings"], "a company this stressed must produce findings"

        scores = [f["score"] for f in body["findings"]]
        assert scores == sorted(scores, reverse=True), "findings must be ranked"

        categories = {f["category"] for f in body["findings"]}
        assert "SUPPLIER_RISK" in categories
        assert "GEOPOLITICAL_RISK" in categories  # 100% of spend in one country

        for finding in body["findings"]:
            assert finding["explanation"]["reasons"]
        assert_explained(body)

    def test_recommendations_are_actionable_and_explained(self, client: TestClient):
        body = client.post("/recommendations/generate", json=self._company()).json()

        assert body["recommendations"], "this company clearly needs advice"

        types = {r["type"] for r in body["recommendations"]}
        assert "ORDER_NOW" in types or "SPLIT_ORDER" in types
        assert "REDUCE_INVENTORY" in types  # SKU-002 holds 600 days of cover
        assert "ADD_SUPPLIER" in types  # one supplier at 80% of spend

        for recommendation in body["recommendations"]:
            assert recommendation["explanation"]["reasons"], (
                "a recommendation without reasons is forbidden by the brief"
            )
            assert recommendation["payload"], "a recommendation must be executable"

        assert_explained(body)

    def test_a_short_site_is_ordered_for_and_said_to_be(self, client: TestClient):
        company = self._company()
        # Accra short of water while the other warehouses hold plenty: the API sends Accra's own
        # stock and demand, with the name of the site and what the others hold.
        company["products"] = [
            {
                "productId": "p6",
                "sku": "SKU-006",
                "currentStock": 610,
                "reservedStock": 10,
                "averageDailyDemand": 320,
                "demandStdDev": 60,
                "leadTimeDays": 3,
                "leadTimeStdDevDays": 0.6,
                "unitCost": 18,
                "warehouseId": "wh-acc",
                "siteName": "Accra Central DC",
                "stockElsewhere": 4712,
            }
        ]

        body = client.post("/recommendations/generate", json=company).json()

        orders = [r for r in body["recommendations"] if r["type"] in {"ORDER_NOW", "SPLIT_ORDER"}]
        assert len(orders) == 1, "two days of cover at a site must produce an order"
        assert orders[0]["payload"]["warehouseId"] == "wh-acc"
        first_reason = orders[0]["explanation"]["reasons"][0]
        assert "Accra Central DC" in first_reason
        assert "4 712" in first_reason and "transfert" in first_reason

    def test_a_network_position_says_nothing_about_a_site(self, client: TestClient):
        body = client.post("/recommendations/generate", json=self._company()).json()

        for recommendation in body["recommendations"]:
            assert not any("Le calcul porte sur" in r for r in recommendation["explanation"]["reasons"])

    def test_priority_ordering_puts_urgency_first(self, client: TestClient):
        body = client.post("/recommendations/generate", json=self._company()).json()
        order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        ranks = [order[r["priority"]] for r in body["recommendations"]]
        assert ranks == sorted(ranks)

    def test_expedite_links_a_late_shipment_to_a_thin_product(self, client: TestClient):
        body = client.post("/recommendations/generate", json=self._company()).json()
        expedites = [r for r in body["recommendations"] if r["type"] == "EXPEDITE_SHIPMENT"]

        assert expedites, "an 80% late shipment feeding a 3-day-cover product must be flagged"
        assert expedites[0]["priority"] in {"CRITICAL", "HIGH"}
        assert "p1" in expedites[0]["payload"]["affectedProductIds"]
