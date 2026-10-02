/**
 * Wire contracts between the NestJS API and the Python AI service.
 * The Pydantic models in `services/ai/app/schemas/` mirror these one-for-one;
 * `services/ai/tests/test_contract_parity.py` fails if a field drifts.
 */

import type {
  AnomalyType,
  ForecastModel,
  OptimizationStatus,
  RecommendationType,
  RiskCategory,
  RiskLevel,
  VehicleType,
} from './enums';
import type { LatLng } from './geo';

/* ------------------------------------------------------------------ common */

export interface Explanation {
  /** One-sentence summary of the decision. */
  summary: string;
  /** Ordered, human-readable reasons. Never empty — an unexplained output is a bug. */
  reasons: string[];
  /** Modelling assumptions that a reader must know to trust the number. */
  assumptions: string[];
}

export interface ModelInfo {
  name: string;
  version: string;
  trainedAt: string | null;
  metrics: Record<string, number>;
}

/* --------------------------------------------------------------- ETA / delay */

export interface EtaPredictRequest {
  origin: LatLng;
  destination: LatLng;
  currentLocation?: LatLng | null;
  /** Ordered planned route. When present, remaining distance follows the polyline. */
  routePolyline?: LatLng[] | null;
  vehicleType: VehicleType;
  departureTime: string;
  /** Observed average speed on this trip so far, km/h. Overrides the vehicle prior when given. */
  observedAverageSpeedKmh?: number | null;
  carrierId?: string | null;
  /** Historical mean/std of speed for this carrier+corridor, if the API has them. */
  historicalAverageSpeedKmh?: number | null;
  historicalSpeedStdKmh?: number | null;
}

export interface EtaPredictResponse {
  estimatedArrival: string;
  estimatedDurationSeconds: number;
  remainingDistanceKm: number;
  effectiveSpeedKmh: number;
  /** 0..1. Shrinks with weak priors, long horizons and high historical variance. */
  confidenceScore: number;
  /** 80 % interval around `estimatedArrival`. */
  arrivalWindow: { earliest: string; latest: string };
  explanation: Explanation;
}

export interface DelayPredictRequest {
  shipmentId?: string | null;
  distanceKm: number;
  plannedDurationHours: number;
  departureHour: number;
  departureDayOfWeek: number;
  vehicleType: VehicleType;
  carrierOnTimeRate: number;
  carrierAverageDelayHours: number;
  supplierReliabilityScore?: number | null;
  weatherSeverity: number;
  trafficCongestion: number;
  routeIncidentRate: number;
  observedAverageSpeedKmh?: number | null;
  stopsCount?: number | null;
}

export interface DelayPredictResponse {
  delayProbability: number;
  risk: RiskLevel;
  expectedDelayHours: number;
  featureContributions: Array<{ feature: string; contribution: number }>;
  model: ModelInfo;
  explanation: Explanation;
}

/* ------------------------------------------------------------------ anomaly */

export interface GpsSample {
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  recordedAt: string;
}

export interface AnomalyDetectRequest {
  shipmentId: string;
  positions: GpsSample[];
  plannedRoute?: LatLng[] | null;
  plannedDurationHours?: number | null;
  /** Metres of deviation tolerated before a ROUTE_DEVIATION is raised. */
  corridorToleranceMeters?: number;
  /** Minutes of near-zero speed before a PROLONGED_STOP is raised. */
  stopToleranceMinutes?: number;
  expectedMaxSpeedKmh?: number;
}

export interface DetectedAnomaly {
  type: AnomalyType;
  severity: RiskLevel;
  /** 0..1 — how far past the threshold the observation sits. */
  score: number;
  detectedAt: string;
  location: LatLng | null;
  description: string;
  evidence: Record<string, number | string | null>;
}

export interface AnomalyDetectResponse {
  shipmentId: string;
  anomalies: DetectedAnomaly[];
  positionsAnalysed: number;
  explanation: Explanation;
}

/* ----------------------------------------------------------------- forecast */

export interface ForecastPoint {
  date: string;
  demand: number;
  lowerBound: number;
  upperBound: number;
}

export interface ForecastRequest {
  productId: string;
  sku: string;
  /** Chronological daily history. Gaps are filled with zeros before modelling. */
  history: Array<{ date: string; quantity: number }>;
  horizonDays: 7 | 30 | 90 | 180;
  /** Restrict the model search. Omit to let the service compare all eligible models. */
  candidateModels?: ForecastModel[];
  serviceLevel?: number;
  seasonalPeriod?: number | null;
}

export interface ModelEvaluation {
  model: ForecastModel;
  mae: number;
  rmse: number;
  mape: number | null;
  wape: number;
  /** Number of validation folds the metrics were averaged over. */
  folds: number;
  selected: boolean;
  /** Filled when a model was skipped rather than evaluated. */
  skippedReason?: string;
}

export interface ForecastResponse {
  productId: string;
  sku: string;
  horizonDays: number;
  forecast: ForecastPoint[];
  selectedModel: ForecastModel;
  evaluations: ModelEvaluation[];
  /** Residual standard deviation of the winning model — feeds safety stock. */
  residualStd: number;
  dataQuality: DataQualityReport;
  explanation: Explanation;
}

export interface DataQualityIssue {
  code: string;
  severity: 'INFO' | 'WARNING' | 'BLOCKING';
  message: string;
  affectedRows: number;
}

export interface DataQualityReport {
  rowsIn: number;
  rowsUsed: number;
  issues: DataQualityIssue[];
  /** False when a BLOCKING issue was found; the caller must not trust downstream numbers. */
  passed: boolean;
}

/* ---------------------------------------------------------------- inventory */

export interface InventoryOptimizeRequest {
  productId: string;
  sku: string;
  currentStock: number;
  /** Units already committed to open orders. */
  reservedStock?: number;
  /** Mean daily demand and its standard deviation, in units. */
  averageDailyDemand: number;
  demandStdDev: number;
  leadTimeDays: number;
  leadTimeStdDevDays: number;
  serviceLevel: number;
  /** Optional economic inputs; when all present an EOQ is returned. */
  orderingCost?: number | null;
  holdingCostPerUnitPerYear?: number | null;
  unitCost?: number | null;
  reviewPeriodDays?: number;
  incomingQuantity?: number;
  incomingArrivalDays?: number | null;
}

export interface InventoryOptimizeResponse {
  safetyStock: number;
  reorderPoint: number;
  recommendedOrderQuantity: number;
  economicOrderQuantity: number | null;
  daysOfCoverRemaining: number;
  projectedStockoutDate: string | null;
  stockoutProbability: number;
  reorderRequired: boolean;
  recommendedOrderDate: string | null;
  expectedStockAfterOrder: number;
  explanation: Explanation;
}

/* ----------------------------------------------------------------- supplier */

export interface SupplierScoreInput {
  supplierId: string;
  name: string;
  unitPrice: number;
  leadTimeDays: number;
  leadTimeStdDevDays?: number;
  onTimeDeliveryRate: number;
  qualityAcceptanceRate: number;
  fillRate?: number;
  minimumOrderQuantity: number;
  capacityUnits: number;
  distanceKm?: number | null;
  cancellationRate?: number;
}

export interface SupplierScoringWeights {
  price: number;
  reliability: number;
  leadTime: number;
  quality: number;
  capacity: number;
  distance: number;
}

export interface SupplierScoreResult {
  supplierId: string;
  name: string;
  score: number;
  rank: number;
  /** Each criterion normalised to 0..1 before weighting, so the maths is auditable. */
  normalized: Record<keyof SupplierScoringWeights, number>;
  weighted: Record<keyof SupplierScoringWeights, number>;
  explanation: Explanation;
}

export interface SupplierScoreRequest {
  suppliers: SupplierScoreInput[];
  weights?: Partial<SupplierScoringWeights>;
}

export interface SupplierScoreResponse {
  results: SupplierScoreResult[];
  weightsUsed: SupplierScoringWeights;
  explanation: Explanation;
}

/* --------------------------------------------------------------- allocation */

export interface AllocationRequest {
  productId?: string | null;
  demandQuantity: number;
  suppliers: SupplierScoreInput[];
  /** Hard cap on total spend. Omit for unconstrained. */
  budget?: number | null;
  /** Days until the goods are needed. Suppliers slower than this get a delay penalty. */
  requiredWithinDays?: number | null;
  /** Max share of the demand any single supplier may take, 0..1. Guards concentration risk. */
  maxSupplierSharePercent?: number | null;
  /** Cost charged per unit short if the plan cannot cover demand. */
  stockoutPenaltyPerUnit?: number;
  /** Cost charged per unit per day late. */
  delayPenaltyPerUnitPerDay?: number;
  /** Cost charged per unit of risk-weighted quantity (1 - reliability). */
  riskPenaltyPerUnit?: number;
  transportCostPerUnitPerKm?: number;
  holdingCostPerUnitPerDay?: number;
}

export interface AllocationLine {
  supplierId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  purchaseCost: number;
  transportCost: number;
  expectedLeadTimeDays: number;
  reliability: number;
  sharePercent: number;
}

export interface AllocationResponse {
  status: OptimizationStatus;
  lines: AllocationLine[];
  unmetDemand: number;
  objectiveValue: number;
  costBreakdown: {
    purchase: number;
    transport: number;
    holding: number;
    stockoutPenalty: number;
    delayPenalty: number;
    riskPenalty: number;
  };
  expectedDeliveryDays: number;
  stockoutRisk: number;
  /** Herfindahl index of the split, 0..1. 1 = everything from one supplier. */
  concentrationIndex: number;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: Explanation;
}

/* -------------------------------------------------------------------- route */

export interface RouteStop {
  id: string;
  name: string;
  location: LatLng;
  demandUnits: number;
  serviceMinutes?: number;
  /** Minutes from the start of the planning horizon. */
  windowStartMinutes?: number | null;
  windowEndMinutes?: number | null;
}

export interface RouteVehicle {
  id: string;
  name: string;
  capacityUnits: number;
  costPerKm: number;
  fuelConsumptionLPer100Km?: number;
  maxDrivingMinutes?: number | null;
  averageSpeedKmh?: number;
}

export interface RouteOptimizeRequest {
  depot: LatLng;
  depotName?: string;
  stops: RouteStop[];
  vehicles: RouteVehicle[];
  fuelPricePerLiter?: number;
  /** Multiplier applied to great-circle distance to approximate road distance. */
  roadWindingFactor?: number;
  solverTimeLimitSeconds?: number;
}

export interface RoutePlan {
  vehicleId: string;
  vehicleName: string;
  sequence: Array<{ id: string; name: string; arrivalMinutes: number; loadAfter: number }>;
  distanceKm: number;
  durationMinutes: number;
  loadUnits: number;
  fuelLiters: number;
  cost: number;
}

export interface RouteOptimizeResponse {
  status: OptimizationStatus;
  routes: RoutePlan[];
  unassignedStops: string[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  totalCost: number;
  objectiveValue: number;
  constraints: string[];
  solverWallTimeMs: number;
  explanation: Explanation;
}

/* ----------------------------------------------------------------- scenario */

export interface ScenarioLevers {
  demandChangePercent?: number;
  fuelPriceChangePercent?: number;
  supplierDelayDays?: number;
  transportCostChangePercent?: number;
  stockLevelChangePercent?: number;
  leadTimeChangePercent?: number;
  unitPriceChangePercent?: number;
}

export interface ScenarioCase {
  name: 'BASE_CASE' | 'BEST_CASE' | 'WORST_CASE' | string;
  levers: ScenarioLevers;
  totalCost: number;
  stockoutRisk: number;
  averageInventoryUnits: number;
  serviceLevel: number;
  expectedDelayDays: number;
  fillRate: number;
}

export interface ScenarioSimulateRequest {
  productId: string;
  sku: string;
  horizonDays: number;
  baseline: {
    averageDailyDemand: number;
    demandStdDev: number;
    currentStock: number;
    unitCost: number;
    leadTimeDays: number;
    leadTimeStdDevDays: number;
    holdingCostPerUnitPerDay: number;
    stockoutPenaltyPerUnit: number;
    transportCostPerOrder: number;
    orderingCost: number;
    serviceLevel: number;
  };
  levers?: ScenarioLevers;
  /** Monte-Carlo iterations. Higher = tighter estimates, linearly slower. */
  iterations?: number;
  randomSeed?: number;
}

export interface ScenarioSimulateResponse {
  productId: string;
  cases: ScenarioCase[];
  iterations: number;
  explanation: Explanation;
}

/* --------------------------------------------------------------------- risk */

export interface RiskFinding {
  category: RiskCategory;
  probability: number;
  impact: number;
  score: number;
  level: RiskLevel;
  subject: string;
  recommendedAction: string;
  explanation: Explanation;
}

export interface RiskAnalyzeRequest {
  companyId: string;
  products: Array<{
    productId: string;
    sku: string;
    currentStock: number;
    averageDailyDemand: number;
    demandStdDev: number;
    leadTimeDays: number;
    incomingQuantity: number;
    incomingArrivalDays: number | null;
    /** Set when the position is one short warehouse, not the network: its name, and the stock held elsewhere. */
    siteName?: string | null;
    stockElsewhere?: number | null;
  }>;
  suppliers: Array<{
    supplierId: string;
    name: string;
    onTimeDeliveryRate: number;
    qualityAcceptanceRate: number;
    sharePercent: number;
    country: string;
    leadTimeStdDevDays: number;
  }>;
  shipments: Array<{
    shipmentId: string;
    delayProbability: number;
    valueAtRisk: number;
    status: string;
  }>;
  /** Live natural-hazard exposures of the company's assets. Absent when no feed was reachable. */
  hazards?: Array<{
    hazardId: string;
    kind: 'CYCLONE' | 'EARTHQUAKE' | 'FIRE' | 'SEVERE_WEATHER' | 'FLOOD' | 'DROUGHT' | 'VOLCANO';
    title: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    subjectType: 'WAREHOUSE' | 'SHIPMENT' | 'SUPPLIER';
    subjectId: string;
    subjectLabel: string;
    distanceKm: number;
  }>;
}

export interface RiskAnalyzeResponse {
  companyId: string;
  findings: RiskFinding[];
  /** 0..100, higher is healthier. */
  supplyChainHealthScore: number;
  healthBreakdown: Record<string, number>;
  explanation: Explanation;
}

/* ---------------------------------------------------------- recommendations */

export interface GeneratedRecommendation {
  type: RecommendationType;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  subjectType: 'PRODUCT' | 'SUPPLIER' | 'SHIPMENT' | 'ROUTE' | 'COMPANY';
  subjectId: string;
  /** Machine-readable payload the API can turn into a real action (e.g. draft PO lines). */
  payload: Record<string, unknown>;
  estimatedImpact: {
    costDelta: number | null;
    riskDelta: number | null;
    serviceLevelDelta: number | null;
  };
  explanation: Explanation;
  expiresAt: string | null;
}

export interface RecommendationsGenerateResponse {
  companyId: string;
  generatedAt: string;
  recommendations: GeneratedRecommendation[];
  explanation: Explanation;
}
