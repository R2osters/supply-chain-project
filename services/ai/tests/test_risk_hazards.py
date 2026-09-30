"""Live hazard exposures feeding the risk engine.

The API's hazards module sends one row per (hazard, asset) pair it judged close enough to matter.
These tests pin down how those rows become findings: which category, how they rank, and that an
analysis without a feed says so instead of implying a calm world.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.engines import risk
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


def exposure(**overrides) -> dict:
    row = {
        "hazardId": "usgs:us1",
        "kind": "EARTHQUAKE",
        "title": "M6.4 earthquake — 12 km SSW of Tema, Ghana",
        "severity": "HIGH",
        "subjectType": "WAREHOUSE",
        "subjectId": "w1",
        "subjectLabel": "Tema DC (TEM)",
        "distanceKm": 12.0,
    }
    row.update(overrides)
    return row


def analyse(hazards):
    return risk.analyse(company_id="c1", products=[], suppliers=[], shipments=[], hazards=hazards)


class TestHazardFindings:
    def test_weights_still_sum_to_one_hundred(self):
        assert sum(risk.HEALTH_WEIGHTS.values()) == pytest.approx(100.0)
        assert "NATURAL_HAZARD" in risk.HEALTH_WEIGHTS

    def test_earthquakes_and_fires_are_natural_hazards_storms_are_weather(self):
        report = analyse(
            [
                exposure(),
                exposure(hazardId="firms:1:2", kind="FIRE", title="Active fire", severity="MEDIUM"),
                exposure(hazardId="nhc:al052026", kind="CYCLONE", title="Hurricane Ernesto", severity="CRITICAL"),
                exposure(hazardId="open-meteo:5.6,-0.2", kind="SEVERE_WEATHER", title="Severe weather"),
            ]
        )
        by_title = {f.reasons[0].split(" (")[0]: f.category for f in report.findings}
        assert by_title["M6.4 earthquake — 12 km SSW of Tema, Ghana"] == "NATURAL_HAZARD"
        assert by_title["Active fire"] == "NATURAL_HAZARD"
        assert by_title["Hurricane Ernesto"] == "WEATHER_RISK"
        assert by_title["Severe weather"] == "WEATHER_RISK"
        assert report.health_breakdown["NATURAL_HAZARD"] > 0
        assert report.health_breakdown["WEATHER_RISK"] > 0

    def test_one_finding_per_hazard_attached_to_the_closest_asset(self):
        report = analyse(
            [
                exposure(subjectId="far", subjectLabel="Kumasi DC", distanceKm=180.0),
                exposure(subjectId="near", subjectLabel="Tema DC", distanceKm=5.0),
            ]
        )
        assert len(report.findings) == 1
        finding = report.findings[0]
        assert finding.subject_id == "near"
        assert any("Kumasi DC" in reason for reason in finding.reasons)

    def test_severity_and_proximity_raise_the_score(self):
        report = analyse(
            [
                exposure(hazardId="a", severity="CRITICAL", distanceKm=5.0),
                exposure(hazardId="b", severity="LOW", distanceKm=5.0),
                exposure(hazardId="c", severity="CRITICAL", distanceKm=240.0),
            ]
        )
        scores = {f.reasons[0]: f.score for f in report.findings}
        critical_near, low_near, critical_far = (
            next(s for r, s in scores.items() if marker in r)
            for marker in (
                "(niveau critique) se trouve à 5 km",
                "(niveau faible) se trouve à 5 km",
                "(niveau critique) se trouve à 240 km",
            )
        )
        assert critical_near > critical_far > 0
        assert critical_near > low_near

    def test_floods_and_droughts_are_weather_eruptions_are_natural_hazards(self):
        report = analyse(
            [
                exposure(hazardId="gdacs:FL:1", kind="FLOOD", title="Flood in Guinea", severity="MEDIUM"),
                exposure(hazardId="gdacs:DR:2", kind="DROUGHT", title="Drought — Europe-2026", severity="HIGH"),
                exposure(hazardId="gdacs:VO:3", kind="VOLCANO", title="Eruption Etna", severity="LOW"),
            ]
        )
        by_title = {f.reasons[0].split(" (")[0]: f for f in report.findings}
        assert by_title["Flood in Guinea"].category == "WEATHER_RISK"
        assert by_title["Drought — Europe-2026"].category == "WEATHER_RISK"
        assert by_title["Eruption Etna"].category == "NATURAL_HAZARD"
        assert "cendres" in by_title["Eruption Etna"].recommended_action

    def test_unknown_kinds_are_ignored(self):
        assert analyse([exposure(kind="METEORITE")]).findings == []

    def test_assumptions_say_whether_a_feed_was_supplied(self):
        without = " ".join(analyse(None).assumptions)
        with_feed = " ".join(analyse([]).assumptions)
        assert "Aucun flux de dangers en direct" in without
        assert "Expositions à un danger fournies : 0" in with_feed


class TestRiskEndpointWithHazards:
    def test_accepts_the_optional_hazards_array(self, client: TestClient):
        body = client.post(
            "/risk/analyze",
            json={"companyId": "c1", "hazards": [exposure(severity="CRITICAL")]},
        ).json()
        assert [f["category"] for f in body["findings"]] == ["NATURAL_HAZARD"]
        assert body["findings"][0]["level"] == "HIGH"
        assert body["supplyChainHealthScore"] < 100

    def test_accepts_the_kinds_gdacs_adds(self, client: TestClient):
        response = client.post(
            "/risk/analyze",
            json={
                "companyId": "c1",
                "hazards": [
                    exposure(hazardId="gdacs:FL:1", kind="FLOOD"),
                    exposure(hazardId="gdacs:DR:2", kind="DROUGHT"),
                    exposure(hazardId="gdacs:VO:3", kind="VOLCANO"),
                ],
            },
        )
        assert response.status_code == 200
        categories = sorted(f["category"] for f in response.json()["findings"])
        assert categories == ["NATURAL_HAZARD", "WEATHER_RISK", "WEATHER_RISK"]

    def test_still_works_without_hazards(self, client: TestClient):
        response = client.post("/risk/analyze", json={"companyId": "c1"})
        assert response.status_code == 200
        assert any(
            "Aucun flux de dangers en direct" in a
            for a in response.json()["explanation"]["assumptions"]
        )

    def test_rejects_a_malformed_hazard(self, client: TestClient):
        response = client.post(
            "/risk/analyze",
            json={"companyId": "c1", "hazards": [exposure(severity="APOCALYPTIC")]},
        )
        assert response.status_code == 422
