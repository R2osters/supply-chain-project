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
            raise ValueError("reservedStock ne peut pas dépasser currentStock")
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


# ----------------------------------------------------------------- delay / ETA


class DelayPredictRequest(Wire):
    shipment_id: str | None = None
    distance_km: float = Field(ge=0)
    planned_duration_hours: float = Field(ge=0)
    departure_hour: int = Field(default=9, ge=0, le=23)
    departure_day_of_week: int = Field(default=1, ge=0, le=6)
    vehicle_type: str = "TRUCK_MEDIUM"
    carrier_on_time_rate: float = Field(default=0.85, ge=0, le=1)
    carrier_average_delay_hours: float = Field(default=0, ge=0)
    supplier_reliability_score: float | None = Field(default=None, ge=0, le=100)
    weather_severity: float = Field(default=0, ge=0, le=1)
    traffic_congestion: float = Field(default=0, ge=0, le=1)
    route_incident_rate: float = Field(default=0, ge=0)
    observed_average_speed_kmh: float | None = Field(default=None, ge=0)
    stops_count: int | None = Field(default=None, ge=0)
    #: Optional labelled history. Supply 30+ rows to fit a model on your own operation.
    training_history: list[dict] | None = None


class ModelInfo(Wire):
    name: str
    version: str
    trained_at: str | None = None
    metrics: dict[str, float] = Field(default_factory=dict)


class FeatureContribution(Wire):
    feature: str
    contribution: float


class DelayPredictResponse(Wire):
    delay_probability: float
    risk: str
    expected_delay_hours: float
    feature_contributions: list[FeatureContribution]
    model: ModelInfo
    explanation: Explanation


# --------------------------------------------------------------------- anomaly


class GpsSampleIn(Wire):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    speed_kmh: float | None = Field(default=None, ge=0, le=400)
    heading_degrees: float | None = Field(default=None, ge=0, lt=360)
    recorded_at: str


class LatLngIn(Wire):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class AnomalyDetectRequest(Wire):
    shipment_id: str
    positions: list[GpsSampleIn]
    planned_route: list[LatLngIn] | None = None
    planned_duration_hours: float | None = Field(default=None, ge=0)
    corridor_tolerance_meters: float = Field(default=2000, ge=50)
    stop_tolerance_minutes: float = Field(default=45, ge=1)
    expected_max_speed_kmh: float = Field(default=110, ge=10, le=400)
    gps_gap_tolerance_minutes: float = Field(default=30, ge=1)
    delivery_point: LatLngIn | None = None
    declared_destination: LatLngIn | None = None


class DetectedAnomalyOut(Wire):
    type: str
    severity: str
    score: float
    detected_at: str
    location: LatLngIn | None
    description: str
    evidence: dict


class AnomalyDetectResponse(Wire):
    shipment_id: str
    anomalies: list[DetectedAnomalyOut]
    positions_analysed: int
    explanation: Explanation


# ----------------------------------------------------------------------- route


class RouteStopIn(Wire):
    id: str
    name: str
    location: LatLngIn
    demand_units: float = Field(ge=0)
    service_minutes: float = Field(default=15, ge=0)
    window_start_minutes: int | None = Field(default=None, ge=0, le=1440)
    window_end_minutes: int | None = Field(default=None, ge=0, le=1440)


class RouteVehicleIn(Wire):
    id: str
    name: str
    capacity_units: float = Field(gt=0)
    cost_per_km: float = Field(default=1.0, ge=0)
    fuel_consumption_l_per_100km: float = Field(default=28, ge=0)
    max_driving_minutes: int | None = Field(default=None, ge=1)
    average_speed_kmh: float = Field(default=55, gt=0, le=160)


class RouteOptimizeRequest(Wire):
    depot: LatLngIn
    depot_name: str = "Dépôt"
    stops: list[RouteStopIn] = Field(min_length=1)
    vehicles: list[RouteVehicleIn] = Field(min_length=1)
    fuel_price_per_liter: float = Field(default=1.35, ge=0)
    road_winding_factor: float = Field(default=1.25, ge=1.0, le=2.5)
    solver_time_limit_seconds: int = Field(default=10, ge=1, le=60)


class RouteStepOut(Wire):
    id: str
    name: str
    arrival_minutes: int
    load_after: float


class RoutePlanOut(Wire):
    vehicle_id: str
    vehicle_name: str
    sequence: list[RouteStepOut]
    distance_km: float
    duration_minutes: float
    load_units: float
    fuel_liters: float
    cost: float


class RouteOptimizeResponse(Wire):
    status: str
    routes: list[RoutePlanOut]
    unassigned_stops: list[str]
    total_distance_km: float
    total_duration_minutes: float
    total_cost: float
    objective_value: float
    constraints: list[str]
    solver_wall_time_ms: int
    explanation: Explanation


# -------------------------------------------------------------------- scenario


class ScenarioLeversIn(Wire):
    demand_change_percent: float = 0.0
    fuel_price_change_percent: float = 0.0
    supplier_delay_days: float = 0.0
    transport_cost_change_percent: float = 0.0
    stock_level_change_percent: float = 0.0
    lead_time_change_percent: float = 0.0
    unit_price_change_percent: float = 0.0


class ScenarioBaselineIn(Wire):
    average_daily_demand: float = Field(ge=0)
    demand_std_dev: float = Field(ge=0)
    current_stock: float = Field(ge=0)
    unit_cost: float = Field(ge=0)
    lead_time_days: float = Field(gt=0)
    lead_time_std_dev_days: float = Field(default=0, ge=0)
    holding_cost_per_unit_per_day: float = Field(default=0.05, ge=0)
    stockout_penalty_per_unit: float = Field(default=25, ge=0)
    transport_cost_per_order: float = Field(default=500, ge=0)
    ordering_cost: float = Field(default=250, ge=0)
    service_level: float = Field(default=0.95, gt=0.5, lt=1)


class ScenarioSimulateRequest(Wire):
    product_id: str
    sku: str
    horizon_days: int = Field(default=90, ge=7, le=730)
    baseline: ScenarioBaselineIn
    levers: ScenarioLeversIn | None = None
    iterations: int = Field(default=2000, ge=100, le=50_000)
    random_seed: int | None = 42


class ScenarioCaseOut(Wire):
    name: str
    levers: ScenarioLeversIn
    total_cost: float
    total_cost_p05: float
    total_cost_p95: float
    stockout_risk: float
    average_inventory_units: float
    service_level: float
    expected_delay_days: float
    fill_rate: float
    orders_placed: float


class ScenarioSimulateResponse(Wire):
    product_id: str
    cases: list[ScenarioCaseOut]
    iterations: int
    explanation: Explanation


# ------------------------------------------------------------------------ risk


class RiskProductIn(Wire):
    product_id: str
    sku: str
    current_stock: float = Field(default=0, ge=0)
    reserved_stock: float = Field(default=0, ge=0)
    average_daily_demand: float = Field(default=0, ge=0)
    demand_std_dev: float = Field(default=0, ge=0)
    lead_time_days: float = Field(default=7, ge=0)
    lead_time_std_dev_days: float = Field(default=0, ge=0)
    incoming_quantity: float = Field(default=0, ge=0)
    incoming_arrival_days: float | None = None
    unit_cost: float = Field(default=0, ge=0)
    service_level: float = Field(default=0.95, gt=0.5, lt=1)
    warehouse_id: str | None = None
    ordering_cost: float | None = Field(default=None, ge=0)
    #: Set when the position is one warehouse that is short rather than the whole network:
    #: its name, and the stock the other warehouses hold.
    site_name: str | None = None
    stock_elsewhere: float | None = Field(default=None, ge=0)


class RiskSupplierIn(Wire):
    supplier_id: str
    name: str
    on_time_delivery_rate: float = Field(default=1, ge=0, le=1)
    quality_acceptance_rate: float = Field(default=1, ge=0, le=1)
    share_percent: float = Field(default=0, ge=0, le=1)
    country: str = "UNKNOWN"
    lead_time_std_dev_days: float = Field(default=0, ge=0)
    unit_price: float | None = Field(default=None, ge=0)
    lead_time_days: float | None = Field(default=None, ge=0)
    capacity_units: float | None = Field(default=None, ge=0)
    minimum_order_quantity: float | None = Field(default=None, ge=0)
    distance_km: float | None = Field(default=None, ge=0)
    product_ids: list[str] = Field(default_factory=list)


class RiskShipmentIn(Wire):
    shipment_id: str
    tracking_number: str | None = None
    delay_probability: float = Field(default=0, ge=0, le=1)
    value_at_risk: float = Field(default=0, ge=0)
    status: str = "IN_TRANSIT"
    product_ids: list[str] = Field(default_factory=list)


class RiskHazardIn(Wire):
    """One live natural hazard near one of the company's assets, from the API's hazards module."""

    hazard_id: str
    kind: Literal["CYCLONE", "EARTHQUAKE", "FIRE", "SEVERE_WEATHER", "FLOOD", "DROUGHT", "VOLCANO"]
    title: str
    severity: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    subject_type: str
    subject_id: str
    subject_label: str
    distance_km: float = Field(ge=0)


class RiskAnalyzeRequest(Wire):
    company_id: str
    products: list[RiskProductIn] = Field(default_factory=list)
    suppliers: list[RiskSupplierIn] = Field(default_factory=list)
    shipments: list[RiskShipmentIn] = Field(default_factory=list)
    # Optional so older callers keep working; absent means "no live feed", not "no hazards".
    hazards: list[RiskHazardIn] | None = None


class RiskFindingOut(Wire):
    category: str
    probability: float
    impact: float
    score: float
    level: str
    subject: str
    subject_type: str
    subject_id: str
    recommended_action: str
    explanation: Explanation


class RiskAnalyzeResponse(Wire):
    company_id: str
    findings: list[RiskFindingOut]
    supply_chain_health_score: float
    health_breakdown: dict[str, float]
    explanation: Explanation


# ------------------------------------------------------------- recommendations


class RecommendationsGenerateRequest(Wire):
    company_id: str
    products: list[RiskProductIn] = Field(default_factory=list)
    suppliers: list[RiskSupplierIn] = Field(default_factory=list)
    shipments: list[RiskShipmentIn] = Field(default_factory=list)


class EstimatedImpact(Wire):
    cost_delta: float | None
    risk_delta: float | None
    service_level_delta: float | None


class GeneratedRecommendationOut(Wire):
    type: str
    priority: str
    title: str
    subject_type: str
    subject_id: str
    payload: dict
    estimated_impact: EstimatedImpact
    explanation: Explanation
    expires_at: str | None


class RecommendationsGenerateResponse(Wire):
    company_id: str
    generated_at: str
    recommendations: list[GeneratedRecommendationOut]
    explanation: Explanation
