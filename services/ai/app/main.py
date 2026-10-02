"""SCIP AI service.

Every endpoint returns its numbers *and* an ``explanation`` block — summary, reasons,
assumptions. That is a hard rule from the brief and it is enforced at the response-model level
rather than by convention: there is no code path that returns a recommendation without one.

Authentication is a shared bearer token presented by the NestJS API. The service is not meant to
be internet-facing, but an unauthenticated optimiser inside a cluster is still an
unauthenticated optimiser, and the check costs nothing.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from datetime import datetime

from .config import get_settings
from .engines import allocation as allocation_engine
from .engines import anomaly as anomaly_engine
from .engines import delay as delay_engine
from .engines import forecasting, inventory
from .engines import recommendations as recommendation_engine
from .engines import risk as risk_engine
from .engines import routing as routing_engine
from .engines import scenario as scenario_engine
from .engines import supplier as supplier_engine
from .schemas import (
    AllocationRequest,
    AllocationResponse,
    AnomalyDetectRequest,
    AnomalyDetectResponse,
    DelayPredictRequest,
    DelayPredictResponse,
    Explanation,
    ForecastRequest,
    ForecastResponse,
    InventoryOptimizeRequest,
    InventoryOptimizeResponse,
    RecommendationsGenerateRequest,
    RecommendationsGenerateResponse,
    RiskAnalyzeRequest,
    RiskAnalyzeResponse,
    RouteOptimizeRequest,
    RouteOptimizeResponse,
    ScenarioSimulateRequest,
    ScenarioSimulateResponse,
    SupplierScoreRequest,
    SupplierScoreResponse,
    SupplierScoringWeights,
)
from .formatting import fr_num

logger = logging.getLogger("scip.ai")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# French labels for codes quoted in a human-readable summary come from the engines that own the
# codes. The response fields themselves keep the codes; an unknown code falls back to itself.
DELAY_RISK_LABELS = delay_engine.RISK_LABELS
ANOMALY_TYPE_LABELS = anomaly_engine.TYPE_LABELS
SEVERITY_LABELS = anomaly_engine.SEVERITY_LABELS


def _label(labels: dict[str, str], code: str) -> str:
    return labels.get(code, code)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info(
        "SCIP AI service %s starting (auth=%s, models_store=%s)",
        settings.version,
        "on" if settings.require_auth else "OFF",
        settings.models_store,
    )
    yield
    logger.info("SCIP AI service stopping")


app = FastAPI(
    title="SCIP AI service",
    version=get_settings().version,
    description=(
        "Forecasting, inventory policy, supplier scoring and optimisation for the Supply Chain "
        "Intelligence Platform. Every response explains itself."
    ),
    lifespan=lifespan,
)


def require_token(request: Request) -> None:
    """Shared-secret bearer check. Skipped entirely when ``require_auth`` is false."""
    settings = get_settings()
    if not settings.require_auth:
        return

    header = request.headers.get("authorization", "")
    presented = header[7:] if header.lower().startswith("bearer ") else ""
    # Compared in constant time so the token cannot be recovered byte by byte from timings.
    import hmac

    if not hmac.compare_digest(presented, settings.ai_service_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Jeton du service IA invalide ou manquant",
        )


@app.middleware("http")
async def log_timing(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Compute-Time-Ms"] = f"{elapsed_ms:.1f}"
    if request.url.path not in {"/health", "/docs", "/openapi.json"}:
        logger.info("%s %s -> %s in %.1f ms", request.method, request.url.path, response.status_code, elapsed_ms)
    return response


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
    """Engine input errors are the caller's fault, not a server fault — 400, not 500."""
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------------------------------------------------------------------- health


@app.get("/health", tags=["health"])
async def health() -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.service_name,
        "version": settings.version,
        "engines": [
            "forecasting",
            "inventory",
            "supplier-scoring",
            "allocation",
            "delay",
            "anomaly",
            "routing",
            "scenario",
            "risk",
            "recommendations",
        ],
    }


# -------------------------------------------------------------------- forecast


@app.post(
    "/forecast",
    response_model=ForecastResponse,
    tags=["forecast"],
    dependencies=[Depends(require_token)],
)
async def forecast(request: ForecastRequest) -> ForecastResponse:
    """Compare candidate models by walk-forward validation, then forecast with the winner."""
    result = forecasting.forecast_demand(
        [point.model_dump() for point in request.history],
        request.horizon_days,
        candidate_models=request.candidate_models,
        seasonal_period=request.seasonal_period,
    )

    quality = result.cleaned.report.to_dict()

    if not result.points:
        # The data-quality gate refused. Return 422 with the reasons rather than an empty
        # forecast that a caller might mistake for "demand is zero".
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": (
                    "L’historique de demande n’a pas passé le contrôle de qualité des données ; "
                    "aucune prévision produite."
                ),
                "dataQuality": quality,
            },
        )

    summary = (
        f"{request.sku} : prévision sur {request.horizon_days} jours avec {result.selected_model}, "
        f"retenu parmi {len([e for e in result.evaluations if e.skipped_reason is None])} "
        "candidat(s) validé(s)."
    )

    return ForecastResponse(
        product_id=request.product_id,
        sku=request.sku,
        horizon_days=request.horizon_days,
        forecast=[point.to_dict() for point in result.points],
        selected_model=result.selected_model,
        evaluations=[evaluation.to_dict() for evaluation in result.evaluations],
        residual_std=result.residual_std,
        data_quality=quality,
        explanation=Explanation(
            summary=summary,
            reasons=result.reasons,
            assumptions=result.assumptions,
        ),
    )


# ------------------------------------------------------------------- inventory


@app.post(
    "/inventory/optimize",
    response_model=InventoryOptimizeResponse,
    tags=["inventory"],
    dependencies=[Depends(require_token)],
)
async def optimize_inventory(request: InventoryOptimizeRequest) -> InventoryOptimizeResponse:
    """Safety stock, reorder point, order quantity and the decision that follows."""
    policy = inventory.optimize_inventory(
        current_stock=request.current_stock,
        reserved_stock=request.reserved_stock,
        average_daily_demand=request.average_daily_demand,
        demand_std=request.demand_std_dev,
        lead_time_days=request.lead_time_days,
        lead_time_std_days=request.lead_time_std_dev_days,
        service_level=request.service_level,
        ordering_cost=request.ordering_cost,
        holding_cost_per_unit_per_year=request.holding_cost_per_unit_per_year,
        unit_cost=request.unit_cost,
        review_period_days=request.review_period_days,
        incoming_quantity=request.incoming_quantity,
        incoming_arrival_days=request.incoming_arrival_days,
    )

    summary = (
        f"{request.sku} : commander {fr_num(policy.recommended_order_quantity)} unités maintenant "
        f"(point de commande {fr_num(policy.reorder_point)}, stock de sécurité "
        f"{fr_num(policy.safety_stock)})."
        if policy.reorder_required
        else (
            f"{request.sku} : pas de commande nécessaire pour l’instant — "
            f"{policy.days_of_cover_remaining:.1f} jours de couverture pour un point de commande "
            f"de {fr_num(policy.reorder_point)}."
        )
    )

    return InventoryOptimizeResponse(
        **policy.to_dict(),
        explanation=Explanation(
            summary=summary, reasons=policy.reasons, assumptions=policy.assumptions
        ),
    )


# -------------------------------------------------------------------- supplier


@app.post(
    "/supplier/score",
    response_model=SupplierScoreResponse,
    tags=["supplier"],
    dependencies=[Depends(require_token)],
)
async def score_suppliers(request: SupplierScoreRequest) -> SupplierScoreResponse:
    """Rank candidates on a weighted, min-max normalised score."""
    weights = request.weights.model_dump() if request.weights else None
    result = supplier_engine.score_suppliers(request.suppliers, weights)

    return SupplierScoreResponse(
        results=[
            {
                "supplierId": entry.supplier_id,
                "name": entry.name,
                "score": entry.score,
                "rank": entry.rank,
                "normalized": entry.normalized,
                "weighted": entry.weighted,
                "explanation": {
                    "summary": f"{entry.name} se classe n° {entry.rank} avec {entry.score:.1f}/100.",
                    "reasons": entry.reasons,
                    "assumptions": result.assumptions,
                },
            }
            for entry in result.results
        ],
        weights_used=SupplierScoringWeights(**result.weights_used),
        explanation=Explanation(
            summary=(
                f"{len(result.results)} fournisseur(s) noté(s) ; "
                f"{result.results[0].name} arrive en tête."
            ),
            reasons=result.reasons,
            assumptions=result.assumptions,
        ),
    )


# ------------------------------------------------------------------ allocation


@app.post(
    "/supplier/allocation",
    response_model=AllocationResponse,
    tags=["supplier"],
    dependencies=[Depends(require_token)],
)
async def allocate_order(request: AllocationRequest) -> AllocationResponse:
    """Split an order across suppliers by solving a mixed-integer program."""
    options = [
        allocation_engine.SupplierOption(
            supplier_id=s.supplier_id,
            name=s.name,
            unit_price=s.unit_price,
            lead_time_days=s.lead_time_days,
            on_time_delivery_rate=s.on_time_delivery_rate,
            capacity_units=s.capacity_units,
            minimum_order_quantity=s.minimum_order_quantity,
            quality_acceptance_rate=s.quality_acceptance_rate,
            distance_km=s.distance_km,
        )
        for s in request.suppliers
    ]

    result = allocation_engine.allocate(
        demand_quantity=request.demand_quantity,
        suppliers=options,
        budget=request.budget,
        required_within_days=request.required_within_days,
        max_supplier_share_percent=request.max_supplier_share_percent,
        stockout_penalty_per_unit=request.stockout_penalty_per_unit,
        delay_penalty_per_unit_per_day=request.delay_penalty_per_unit_per_day,
        risk_penalty_per_unit=request.risk_penalty_per_unit,
        transport_cost_per_unit_per_km=request.transport_cost_per_unit_per_km,
        holding_cost_per_unit_per_day=request.holding_cost_per_unit_per_day,
    )

    payload = result.to_dict()

    if result.lines:
        split = ", ".join(f"{line.name} {fr_num(line.quantity)}" for line in result.lines)
        summary = (
            f"Répartir {fr_num(request.demand_quantity)} unités ainsi : {split} — coût total modélisé "
            f"{fr_num(result.objective_value)}, manque attendu {result.stockout_risk:.1%}."
        )
    else:
        summary = "Aucune répartition réalisable n’a été trouvée pour les contraintes fournies."

    return AllocationResponse(
        status=payload["status"],
        lines=payload["lines"],
        unmet_demand=payload["unmetDemand"],
        objective_value=payload["objectiveValue"] if result.lines else None,
        cost_breakdown=payload["costBreakdown"] or None,
        expected_delivery_days=payload["expectedDeliveryDays"],
        stockout_risk=payload["stockoutRisk"],
        concentration_index=payload["concentrationIndex"],
        constraints=payload["constraints"],
        solver_wall_time_ms=payload["solverWallTimeMs"],
        explanation=Explanation(
            summary=summary, reasons=result.reasons, assumptions=result.assumptions
        ),
    )


# ----------------------------------------------------------------------- delay


@app.post(
    "/predict-delay",
    response_model=DelayPredictResponse,
    tags=["tracking"],
    dependencies=[Depends(require_token)],
)
async def predict_delay(request: DelayPredictRequest) -> DelayPredictResponse:
    """Probability that a shipment arrives late, with per-feature attribution."""
    payload = request.model_dump(by_alias=True, exclude_none=False)
    history = request.training_history or []

    prediction = (
        delay_engine.train_and_predict(payload, history)
        if history
        else delay_engine.predict_scorecard(payload)
    )

    return DelayPredictResponse(
        **prediction.to_dict(),
        explanation=Explanation(
            summary=(
                f"Probabilité de retard {prediction.delay_probability:.1%} "
                f"(risque {_label(DELAY_RISK_LABELS, prediction.risk)}) selon "
                f"{prediction.model_name}."
            ),
            reasons=prediction.reasons,
            assumptions=prediction.assumptions,
        ),
    )


# --------------------------------------------------------------------- anomaly


@app.post(
    "/detect-anomaly",
    response_model=AnomalyDetectResponse,
    tags=["tracking"],
    dependencies=[Depends(require_token)],
)
async def detect_anomaly(request: AnomalyDetectRequest) -> AnomalyDetectResponse:
    """Rule-based anomaly detection over a shipment's GPS track."""
    samples = []
    for position in request.positions:
        try:
            recorded_at = datetime.fromisoformat(position.recorded_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(
                f"recordedAt « {position.recorded_at} » n’est pas une date-heure ISO valide"
            ) from exc
        samples.append(
            anomaly_engine.GpsSample(
                latitude=position.latitude,
                longitude=position.longitude,
                speed_kmh=position.speed_kmh,
                heading_degrees=position.heading_degrees,
                recorded_at=recorded_at,
            )
        )

    report = anomaly_engine.detect_anomalies(
        request.shipment_id,
        samples,
        planned_route=(
            [(p.latitude, p.longitude) for p in request.planned_route]
            if request.planned_route
            else None
        ),
        planned_duration_hours=request.planned_duration_hours,
        corridor_tolerance_m=request.corridor_tolerance_meters,
        stop_tolerance_minutes=request.stop_tolerance_minutes,
        expected_max_speed_kmh=request.expected_max_speed_kmh,
        gps_gap_tolerance_minutes=request.gps_gap_tolerance_minutes,
        delivery_point=(
            (request.delivery_point.latitude, request.delivery_point.longitude)
            if request.delivery_point
            else None
        ),
        declared_destination=(
            (request.declared_destination.latitude, request.declared_destination.longitude)
            if request.declared_destination
            else None
        ),
    )

    highest = report.anomalies[0] if report.anomalies else None
    summary = (
        f"{len(report.anomalies)} anomalie(s) sur {report.positions_analysed} positions ; "
        f"la plus grave : {_label(ANOMALY_TYPE_LABELS, highest.type)} "
        f"(gravité {_label(SEVERITY_LABELS, highest.severity)})."
        if highest
        else f"Aucune anomalie sur {report.positions_analysed} positions."
    )

    return AnomalyDetectResponse(
        shipment_id=report.shipment_id,
        anomalies=[a.to_dict() for a in report.anomalies],
        positions_analysed=report.positions_analysed,
        explanation=Explanation(
            summary=summary, reasons=report.reasons, assumptions=report.assumptions
        ),
    )


# ----------------------------------------------------------------------- route


@app.post(
    "/route/optimize",
    response_model=RouteOptimizeResponse,
    tags=["routing"],
    dependencies=[Depends(require_token)],
)
async def optimize_route(request: RouteOptimizeRequest) -> RouteOptimizeResponse:
    """Capacitated vehicle routing with time windows."""
    result = routing_engine.optimize_routes(
        depot=(request.depot.latitude, request.depot.longitude),
        depot_name=request.depot_name,
        stops=[
            routing_engine.RouteStop(
                id=stop.id,
                name=stop.name,
                latitude=stop.location.latitude,
                longitude=stop.location.longitude,
                demand_units=stop.demand_units,
                service_minutes=stop.service_minutes,
                window_start_minutes=stop.window_start_minutes,
                window_end_minutes=stop.window_end_minutes,
            )
            for stop in request.stops
        ],
        vehicles=[
            routing_engine.RouteVehicle(
                id=vehicle.id,
                name=vehicle.name,
                capacity_units=vehicle.capacity_units,
                cost_per_km=vehicle.cost_per_km,
                fuel_consumption_l_per_100km=vehicle.fuel_consumption_l_per_100km,
                max_driving_minutes=vehicle.max_driving_minutes,
                average_speed_kmh=vehicle.average_speed_kmh,
            )
            for vehicle in request.vehicles
        ],
        fuel_price_per_liter=request.fuel_price_per_liter,
        road_winding_factor=request.road_winding_factor,
        solver_time_limit_seconds=request.solver_time_limit_seconds,
    )

    payload = result.to_dict()
    summary = (
        f"{len(result.routes)} tournée(s) couvrant "
        f"{len(request.stops) - len(result.unassigned_stops)} arrêt(s) sur {len(request.stops)}, "
        f"{fr_num(result.total_distance_km)} km, coût estimé {fr_num(result.total_cost)}."
    )

    return RouteOptimizeResponse(
        **payload,
        explanation=Explanation(
            summary=summary, reasons=result.reasons, assumptions=result.assumptions
        ),
    )


# -------------------------------------------------------------------- scenario


@app.post(
    "/scenario/simulate",
    response_model=ScenarioSimulateResponse,
    tags=["scenario"],
    dependencies=[Depends(require_token)],
)
async def simulate_scenario(request: ScenarioSimulateRequest) -> ScenarioSimulateResponse:
    """Monte-Carlo what-if analysis across base, best and worst cases."""
    baseline = scenario_engine.Baseline(**request.baseline.model_dump())
    levers = (
        scenario_engine.Levers(**request.levers.model_dump())
        if request.levers
        else scenario_engine.Levers()
    )

    result = scenario_engine.simulate(
        baseline=baseline,
        levers=levers,
        horizon_days=request.horizon_days,
        iterations=request.iterations,
        random_seed=request.random_seed,
    )

    base = next(c for c in result.cases if c.name == "BASE_CASE")
    worst = next(c for c in result.cases if c.name == "WORST_CASE")

    return ScenarioSimulateResponse(
        product_id=request.product_id,
        cases=[case.to_dict() for case in result.cases],
        iterations=result.iterations,
        explanation=Explanation(
            summary=(
                f"{request.sku} : coût du cas de base {fr_num(base.total_cost)} avec un risque de "
                f"rupture de {base.stockout_risk:.0%} ; pire cas "
                f"{fr_num(worst.total_cost)} avec {worst.stockout_risk:.0%}."
            ),
            reasons=result.reasons,
            assumptions=result.assumptions,
        ),
    )


# ------------------------------------------------------------------------ risk


@app.post(
    "/risk/analyze",
    response_model=RiskAnalyzeResponse,
    tags=["risk"],
    dependencies=[Depends(require_token)],
)
async def analyze_risk(request: RiskAnalyzeRequest) -> RiskAnalyzeResponse:
    """Categorised risk findings and the Supply Chain Health Score."""
    report = risk_engine.analyse(
        company_id=request.company_id,
        products=[p.model_dump(by_alias=True) for p in request.products],
        suppliers=[s.model_dump(by_alias=True) for s in request.suppliers],
        shipments=[s.model_dump(by_alias=True) for s in request.shipments],
        hazards=(
            None
            if request.hazards is None
            else [h.model_dump(by_alias=True) for h in request.hazards]
        ),
    )

    return RiskAnalyzeResponse(
        company_id=request.company_id,
        findings=[finding.to_dict() for finding in report.findings],
        supply_chain_health_score=report.health_score,
        health_breakdown=report.health_breakdown,
        explanation=Explanation(
            summary=(
                f"Santé de la chaîne d’approvisionnement : {report.health_score:.0f}/100, "
                f"{len(report.findings)} constat(s)."
            ),
            reasons=report.reasons,
            assumptions=report.assumptions,
        ),
    )


# ------------------------------------------------------------- recommendations


@app.post(
    "/recommendations/generate",
    response_model=RecommendationsGenerateResponse,
    tags=["recommendations"],
    dependencies=[Depends(require_token)],
)
async def generate_recommendations(
    request: RecommendationsGenerateRequest,
) -> RecommendationsGenerateResponse:
    """Turn the whole picture into ranked, executable recommendations."""
    result = recommendation_engine.generate(
        company_id=request.company_id,
        products=[p.model_dump(by_alias=True) for p in request.products],
        suppliers=[s.model_dump(by_alias=True) for s in request.suppliers],
        shipments=[s.model_dump(by_alias=True) for s in request.shipments],
    )

    urgent = sum(
        1 for r in result.recommendations if r.priority in {"CRITICAL", "HIGH"}
    )

    return RecommendationsGenerateResponse(
        company_id=request.company_id,
        generated_at=datetime.now().isoformat(),
        recommendations=[r.to_dict() for r in result.recommendations],
        explanation=Explanation(
            summary=(
                f"{len(result.recommendations)} recommandation(s), dont {urgent} à traiter "
                "maintenant."
            ),
            reasons=result.reasons,
            assumptions=result.assumptions,
        ),
    )
