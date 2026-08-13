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

from .config import get_settings
from .engines import allocation as allocation_engine
from .engines import forecasting, inventory
from .engines import supplier as supplier_engine
from .schemas import (
    AllocationRequest,
    AllocationResponse,
    Explanation,
    ForecastRequest,
    ForecastResponse,
    InventoryOptimizeRequest,
    InventoryOptimizeResponse,
    SupplierScoreRequest,
    SupplierScoreResponse,
    SupplierScoringWeights,
)

logger = logging.getLogger("scip.ai")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


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
            detail="Invalid or missing AI service token",
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
                "message": "Demand history failed data-quality validation; no forecast produced.",
                "dataQuality": quality,
            },
        )

    summary = (
        f"{request.sku}: {request.horizon_days}-day forecast using {result.selected_model}, "
        f"selected from {len([e for e in result.evaluations if e.skipped_reason is None])} "
        "validated candidate(s)."
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
        f"{request.sku}: order {policy.recommended_order_quantity:,.0f} units now "
        f"(reorder point {policy.reorder_point:,.0f}, safety stock {policy.safety_stock:,.0f})."
        if policy.reorder_required
        else (
            f"{request.sku}: no order needed yet — "
            f"{policy.days_of_cover_remaining:.1f} days of cover against a reorder point of "
            f"{policy.reorder_point:,.0f}."
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
                    "summary": f"{entry.name} ranks #{entry.rank} with {entry.score:.1f}/100.",
                    "reasons": entry.reasons,
                    "assumptions": result.assumptions,
                },
            }
            for entry in result.results
        ],
        weights_used=SupplierScoringWeights(**result.weights_used),
        explanation=Explanation(
            summary=(
                f"Scored {len(result.results)} supplier(s); "
                f"{result.results[0].name} ranks first."
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
        split = ", ".join(f"{line.name} {line.quantity:,.0f}" for line in result.lines)
        summary = (
            f"Allocate {request.demand_quantity:,.0f} units as {split} — total modelled cost "
            f"{result.objective_value:,.0f}, expected shortfall {result.stockout_risk:.1%}."
        )
    else:
        summary = "No feasible allocation was found for the constraints supplied."

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
