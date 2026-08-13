/**
 * Domain vocabulary shared by the API, the web app and (via generated JSON) the AI service.
 * These string literals must stay in sync with the Prisma enums in apps/api/prisma/schema.prisma.
 * `npm run check:enums --workspace @scip/api` asserts that they do.
 */

export const USER_ROLES = [
  'SUPER_ADMIN',
  'COMPANY_ADMIN',
  'SUPPLY_CHAIN_MANAGER',
  'LOGISTICS_MANAGER',
  'PROCUREMENT_MANAGER',
  'WAREHOUSE_MANAGER',
  'DRIVER',
  'SUPPLIER',
  'CUSTOMER',
  'VIEWER',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const SHIPMENT_STATUSES = [
  'PLANNED',
  'LOADING',
  'DEPARTED',
  'IN_TRANSIT',
  'DELAYED',
  'ARRIVED',
  'DELIVERED',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'FAILED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const STOCK_MOVEMENT_TYPES = ['IN', 'OUT', 'TRANSFER', 'ADJUSTMENT'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const INVENTORY_ALERT_TYPES = ['LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING_SOON', 'OVERSTOCK'] as const;
export type InventoryAlertType = (typeof INVENTORY_ALERT_TYPES)[number];

export const INCIDENT_TYPES = [
  'DELAY',
  'ACCIDENT',
  'VEHICLE_BREAKDOWN',
  'DAMAGED_CARGO',
  'LOST_CARGO',
  'WRONG_ROUTE',
  'CUSTOMS_DELAY',
  'WEATHER',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const ANOMALY_TYPES = [
  'UNUSUAL_STOP',
  'ROUTE_DEVIATION',
  'ABNORMAL_SPEED',
  'GPS_LOSS',
  'EXCESSIVE_DURATION',
  'PROLONGED_STOP',
  'SUSPICIOUS_DELIVERY',
  'GEOFENCE_BREACH',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_CATEGORIES = [
  'SUPPLIER_RISK',
  'STOCKOUT_RISK',
  'TRANSPORT_RISK',
  'DEMAND_RISK',
  'GEOPOLITICAL_RISK',
  'WEATHER_RISK',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RECOMMENDATION_TYPES = [
  'ORDER_NOW',
  'WAIT',
  'CHANGE_SUPPLIER',
  'SPLIT_ORDER',
  'INCREASE_SAFETY_STOCK',
  'REDUCE_INVENTORY',
  'CHANGE_ROUTE',
  'ADD_SUPPLIER',
  'EXPEDITE_SHIPMENT',
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_STATUSES = ['OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'EXECUTED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const RECOMMENDATION_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RecommendationPriority = (typeof RECOMMENDATION_PRIORITIES)[number];

export const NOTIFICATION_CHANNELS = ['DASHBOARD', 'EMAIL', 'PUSH', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'SHIPMENT_DELAYED',
  'SHIPMENT_ARRIVING',
  'SHIPMENT_DELIVERED',
  'VEHICLE_STOPPED',
  'ROUTE_DEVIATION',
  'LOW_STOCK',
  'OUT_OF_STOCK',
  'EXPIRING_SOON',
  'INCIDENT_CREATED',
  'INCIDENT_RESOLVED',
  'PO_CONFIRMED',
  'RECOMMENDATION_CREATED',
  'ANOMALY_DETECTED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const VEHICLE_TYPES = ['VAN', 'TRUCK_SMALL', 'TRUCK_MEDIUM', 'TRUCK_LARGE', 'REFRIGERATED', 'CONTAINER'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_STATUSES = ['AVAILABLE', 'IN_TRANSIT', 'MAINTENANCE', 'OUT_OF_SERVICE'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const SHIPMENT_EVENT_TYPES = [
  'CREATED',
  'STATUS_CHANGED',
  'DEPARTED',
  'CHECKPOINT',
  'DELAY_DETECTED',
  'ANOMALY_DETECTED',
  'ARRIVED',
  'DELIVERED',
  'INCIDENT',
  'ETA_UPDATED',
] as const;
export type ShipmentEventType = (typeof SHIPMENT_EVENT_TYPES)[number];

export const FORECAST_MODELS = [
  'NAIVE',
  'MOVING_AVERAGE',
  'EXPONENTIAL_SMOOTHING',
  'HOLT_WINTERS',
  'SEASONAL_NAIVE',
  'GRADIENT_BOOSTING',
] as const;
export type ForecastModel = (typeof FORECAST_MODELS)[number];

export const OPTIMIZATION_KINDS = [
  'SUPPLIER_ALLOCATION',
  'ROUTE_VRP',
  'INVENTORY_POLICY',
  'SCENARIO_SIMULATION',
] as const;
export type OptimizationKind = (typeof OPTIMIZATION_KINDS)[number];

export const OPTIMIZATION_STATUSES = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'ERROR'] as const;
export type OptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];
