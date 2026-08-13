"""Request and response models.

These mirror `packages/shared/src/contracts.ts` field for field, in camelCase, because the
NestJS API is the only caller and it speaks TypeScript. Pydantic aliases keep the Python side
idiomatic (snake_case attributes) without forcing the wire format to follow.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(word.capitalize() for word in tail)


class Wire(BaseModel):
    """Base: accepts and emits camelCase, populated by snake_case attribute names."""

    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra="forbid")


class Explanation(Wire):
    summary: str
    reasons: list[str]
    assumptions: list[str]


# --------------------------------------------------------------------- forecast


class HistoryPoint(Wire):
    date: str
    quantity: float


class ForecastRequest(Wire):
    product_id: str
    sku: str
    history: list[HistoryPoint]
    horizon_days: Literal[7, 30, 90, 180] = 30
    candidate_models: list[str] | None = None
    service_level: float = Field(default=0.95, gt=0.5, lt=1.0)
    seasonal_period: int | None = Field(default=None, ge=2, le=365)


class ForecastPointOut(Wire):
    date: str
    demand: float
    lower_bound: float
    upper_bound: float


class ModelEvaluationOut(Wire):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra="allow")

    model: str
    mae: float | None = None
    rmse: float | None = None
    mape: float | None = None
    wape: float | None = None
    folds: int = 0
    selected: bool = False
    skipped_reason: str | None = None


class DataQualityIssueOut(Wire):
    code: str
    severity: str
    message: str
    affected_rows: int


class DataQualityReportOut(Wire):
    rows_in: int
    rows_used: int
    issues: list[DataQualityIssueOut]
    passed: bool


class ForecastResponse(Wire):
    product_id: str
    sku: str
    horizon_days: int
    forecast: list[ForecastPointOut]
    selected_model: str
    evaluations: list[ModelEvaluationOut]
    residual_std: float | None
    data_quality: DataQualityReportOut
    explanation: Explanation


# -------------------------------------------------------------------- inventory


class InventoryOptimizeRequest(Wire):
    product_id: str
    sku: str
    current_stock: float = Field(ge=0)
    reserved_stock: float = Field(default=0, ge=0)
    average_daily_demand: float = Field(ge=0)
    demand_std_dev: float = Field(ge=0)
    lead_time_days: float = Field(ge=0)
    lead_time_std_dev_days: float = Field(default=0, ge=0)
    service_level: float = Field(default=0.95, gt=0.5, lt=1.0)
    ordering_cost: float | None = Field(default=None, ge=0)
    holding_cost_per_unit_per_year: float | None = Field(default=None, ge=0)
    unit_cost: float | None = Field(default=None, ge=0)
    review_period_days: float = Field(default=0, ge=0)
    incoming_quantity: float = Field(default=0, ge=0)
    incoming_arrival_days: float | None = Field(default=None, ge=0)

    @field_validator("reserved_stock")
    @classmethod
    def reserved_within_stock(cls, value: float, info) -> float:
        current = info.data.get("current_stock")
        if current is not None and value > current:
            raise ValueError("reservedStock cannot exceed currentStock")
        return value


class InventoryOptimizeResponse(Wire):
    safety_stock: float
    reorder_point: float
    recommended_order_quantity: float
    economic_order_quantity: float | None
    days_of_cover_remaining: float
    projected_stockout_date: str | None
    stockout_probability: float
    reorder_required: bool
    recommended_order_date: str | None
    expected_stock_after_order: float
    explanation: Explanation


# --------------------------------------------------------------------- supplier


class SupplierInput(Wire):
    supplier_id: str
    name: str
    unit_price: float = Field(ge=0)
    lead_time_days: float = Field(ge=0)
    lead_time_std_dev_days: float = Field(default=0, ge=0)
    on_time_delivery_rate: float = Field(ge=0, le=1)
    quality_acceptance_rate: float = Field(default=1.0, ge=0, le=1)
    fill_rate: float = Field(default=1.0, ge=0, le=1)
    minimum_order_quantity: float = Field(default=0, ge=0)
    capacity_units: float = Field(ge=0)
    distance_km: float | None = Field(default=None, ge=0)
    cancellation_rate: float = Field(default=0, ge=0, le=1)


class SupplierScoringWeights(Wire):
    price: float = 0.30
    reliability: float = 0.25
    lead_time: float = 0.20
    quality: float = 0.15
    capacity: float = 0.05
    distance: float = 0.05


class SupplierScoreRequest(Wire):
    suppliers: list[SupplierInput] = Field(min_length=1)
    weights: SupplierScoringWeights | None = None


class SupplierScoreResult(Wire):
    supplier_id: str
    name: str
    score: float
    rank: int
    normalized: dict[str, float]
    weighted: dict[str, float]
    explanation: Explanation


class SupplierScoreResponse(Wire):
    results: list[SupplierScoreResult]
    weights_used: SupplierScoringWeights
    explanation: Explanation


# ------------------------------------------------------------------ allocation


class AllocationRequest(Wire):
    product_id: str | None = None
    demand_quantity: float = Field(gt=0)
    suppliers: list[SupplierInput] = Field(min_length=1)
    budget: float | None = Field(default=None, gt=0)
    required_within_days: float | None = Field(default=None, ge=0)
    max_supplier_share_percent: float | None = Field(default=None, gt=0, le=1)
    stockout_penalty_per_unit: float = Field(default=25.0, ge=0)
    delay_penalty_per_unit_per_day: float = Field(default=0.5, ge=0)
    risk_penalty_per_unit: float = Field(default=8.0, ge=0)
    transport_cost_per_unit_per_km: float = Field(default=0.002, ge=0)
    holding_cost_per_unit_per_day: float = Field(default=0.05, ge=0)


class AllocationLineOut(Wire):
    supplier_id: str
    name: str
    quantity: float
    unit_price: float
    purchase_cost: float
    transport_cost: float
    expected_lead_time_days: float
    reliability: float
    share_percent: float


class CostBreakdown(Wire):
    purchase: float
    transport: float
    holding: float
    stockout_penalty: float
    delay_penalty: float
    risk_penalty: float


class AllocationResponse(Wire):
    status: str
    lines: list[AllocationLineOut]
    unmet_demand: float
    objective_value: float | None
    cost_breakdown: CostBreakdown | None
    expected_delivery_days: float
    stockout_risk: float
    concentration_index: float
    constraints: list[str]
    solver_wall_time_ms: int
    explanation: Explanation
