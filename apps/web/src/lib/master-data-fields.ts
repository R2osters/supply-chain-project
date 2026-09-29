import { VEHICLE_STATUSES, VEHICLE_TYPES } from '@scip/shared';
import type { FieldOption, FieldSpec } from './entity-form';
import type { TranslationKey } from './i18n';

/**
 * One spec per API DTO. Names, requiredness, lengths and numeric ranges are copied from
 * `apps/api/src/modules/master-data/master-data.dto.ts` and `suppliers/suppliers.dto.ts`; keep
 * them in step when a DTO changes, because the API rejects any property it does not declare.
 *
 * Select options that come from other tables (categories, carriers, vehicles, products) are
 * passed in by the screen that has loaded them.
 */

const CONTACT: FieldSpec[] = [
  { name: 'contactName', labelKey: 'md.f.contactName', kind: 'text', maxLength: 120, nullable: true },
  { name: 'contactEmail', labelKey: 'md.f.contactEmail', kind: 'email', maxLength: 180, nullable: true },
  { name: 'contactPhone', labelKey: 'md.f.contactPhone', kind: 'tel', maxLength: 40, nullable: true },
];

const CODE = (max: number, minLength?: number): FieldSpec => ({
  name: 'code',
  labelKey: 'md.f.code',
  kind: 'text',
  required: true,
  minLength,
  maxLength: max,
  upper: true,
});

const NAME: FieldSpec = { name: 'name', labelKey: 'md.f.name', kind: 'text', required: true, minLength: 2, maxLength: 160 };
const COUNTRY: FieldSpec = {
  name: 'country',
  labelKey: 'md.f.country',
  kind: 'text',
  required: true,
  maxLength: 60,
  hintKey: 'md.h.country',
  upper: true,
};
const CITY: FieldSpec = { name: 'city', labelKey: 'md.f.city', kind: 'text', maxLength: 120, nullable: true };
const ADDRESS: FieldSpec = {
  name: 'addressLine',
  labelKey: 'md.f.address',
  kind: 'text',
  maxLength: 240,
  nullable: true,
  wide: true,
};

function coordinates(required: boolean): FieldSpec[] {
  return [
    {
      name: 'latitude',
      labelKey: 'md.f.latitude',
      kind: 'number',
      min: -90,
      max: 90,
      required,
      nullable: !required,
      requiredWith: required ? undefined : 'longitude',
      placeholder: '5.6037',
    },
    {
      name: 'longitude',
      labelKey: 'md.f.longitude',
      kind: 'number',
      min: -180,
      max: 180,
      required,
      nullable: !required,
      requiredWith: required ? undefined : 'latitude',
      placeholder: '-0.187',
    },
  ];
}

/* ------------------------------------------------------------------ suppliers */

export const SUPPLIER_FIELDS: FieldSpec[] = [
  CODE(40),
  NAME,
  COUNTRY,
  CITY,
  ADDRESS,
  ...CONTACT,
  ...coordinates(false),
  {
    name: 'quotedLeadTimeDays',
    labelKey: 'md.f.quotedLead',
    kind: 'integer',
    min: 0,
    max: 365,
    placeholder: '7',
    hintKey: 'md.h.quotedLead',
  },
  { name: 'paymentTerms', labelKey: 'md.f.paymentTerms', kind: 'text', maxLength: 40, placeholder: 'NET_30', upper: true },
  { name: 'currency', labelKey: 'md.f.currency', kind: 'text', maxLength: 3, placeholder: 'USD', upper: true },
];

export function supplierProductFields(products: FieldOption[]): FieldSpec[] {
  return [
    { name: 'productId', labelKey: 'md.f.product', kind: 'select', required: true, options: products, wide: true },
    { name: 'unitPrice', labelKey: 'md.f.unitPrice', kind: 'number', required: true, min: 0 },
    { name: 'currency', labelKey: 'md.f.currency', kind: 'text', maxLength: 3, placeholder: 'USD', upper: true, hintKey: 'md.h.spCurrency' },
    { name: 'minimumOrderQuantity', labelKey: 'md.f.moq', kind: 'number', min: 0, placeholder: '1' },
    {
      name: 'capacityPerCycle',
      labelKey: 'md.f.capacityPerCycle',
      kind: 'number',
      required: true,
      min: 0,
      hintKey: 'md.h.capacityPerCycle',
    },
    { name: 'leadTimeDays', labelKey: 'md.f.leadTime', kind: 'integer', required: true, min: 0, max: 365 },
  ];
}

/* ------------------------------------------------------------------ customers */

export const CUSTOMER_FIELDS: FieldSpec[] = [
  CODE(40, 1),
  NAME,
  COUNTRY,
  CITY,
  ADDRESS,
  ...CONTACT,
  ...coordinates(false),
  {
    name: 'windowStartMinutes',
    labelKey: 'md.f.windowStart',
    kind: 'integer',
    min: 0,
    max: 1440,
    nullable: true,
    hintKey: 'md.h.window',
    placeholder: '480',
  },
  {
    name: 'windowEndMinutes',
    labelKey: 'md.f.windowEnd',
    kind: 'integer',
    min: 0,
    max: 1440,
    nullable: true,
    placeholder: '1080',
  },
];

/* ------------------------------------------------------------------- carriers */

export const CARRIER_FIELDS: FieldSpec[] = [
  CODE(40),
  NAME,
  COUNTRY,
  { name: 'contactEmail', labelKey: 'md.f.contactEmail', kind: 'email', maxLength: 180, nullable: true },
  { name: 'contactPhone', labelKey: 'md.f.contactPhone', kind: 'tel', maxLength: 40, nullable: true },
  { name: 'costPerKm', labelKey: 'md.f.costPerKm', kind: 'number', min: 0, placeholder: '0' },
];

/* ----------------------------------------------------------------- warehouses */

export const WAREHOUSE_FIELDS: FieldSpec[] = [
  CODE(40),
  NAME,
  COUNTRY,
  CITY,
  ADDRESS,
  ...coordinates(true),
  { name: 'capacityUnits', labelKey: 'md.f.capacityUnits', kind: 'number', min: 0, nullable: true },
  {
    name: 'geofenceRadiusM',
    labelKey: 'md.f.geofence',
    kind: 'integer',
    min: 25,
    max: 20000,
    placeholder: '300',
    hintKey: 'md.h.geofence',
  },
];

export const LOCATION_FIELDS: FieldSpec[] = [
  { name: 'code', labelKey: 'md.f.locationCode', kind: 'text', required: true, maxLength: 40, upper: true, placeholder: 'A-01-3-2', wide: true },
  { name: 'zone', labelKey: 'md.f.zone', kind: 'text', maxLength: 40 },
  { name: 'aisle', labelKey: 'md.f.aisle', kind: 'text', maxLength: 40 },
  { name: 'rack', labelKey: 'md.f.rack', kind: 'text', maxLength: 40 },
  { name: 'shelf', labelKey: 'md.f.shelf', kind: 'text', maxLength: 40 },
];

/* ------------------------------------------------------------------- vehicles */

export function vehicleFields(
  carriers: FieldOption[],
  label: (key: TranslationKey) => string,
): FieldSpec[] {
  return [
    { name: 'plateNumber', labelKey: 'md.f.plate', kind: 'text', required: true, maxLength: 30, upper: true },
    { name: 'label', labelKey: 'md.f.label', kind: 'text', maxLength: 80, nullable: true, placeholder: 'Truck 12' },
    {
      name: 'type',
      labelKey: 'md.f.vehicleType',
      kind: 'select',
      required: true,
      options: VEHICLE_TYPES.map((value) => ({ value, label: label(`md.vt.${value}` as TranslationKey) })),
    },
    {
      name: 'status',
      labelKey: 'md.f.vehicleStatus',
      kind: 'select',
      options: VEHICLE_STATUSES.map((value) => ({ value, label: label(`md.vs.${value}` as TranslationKey) })),
    },
    { name: 'carrierId', labelKey: 'md.f.carrier', kind: 'select', options: carriers, allowEmpty: true, nullable: true },
    { name: 'capacityUnits', labelKey: 'md.f.capacityUnits', kind: 'number', required: true, min: 0 },
    { name: 'capacityKg', labelKey: 'md.f.capacityKg', kind: 'number', min: 0, nullable: true },
    {
      name: 'fuelConsumptionLPer100Km',
      labelKey: 'md.f.fuel',
      kind: 'number',
      min: 0,
      max: 200,
      placeholder: '28',
    },
    { name: 'costPerKm', labelKey: 'md.f.costPerKm', kind: 'number', min: 0, placeholder: '0.9' },
    {
      name: 'nominalSpeedKmh',
      labelKey: 'md.f.speed',
      kind: 'number',
      min: 5,
      max: 160,
      placeholder: '60',
      hintKey: 'md.h.speed',
    },
  ];
}

/* -------------------------------------------------------------------- drivers */

export function driverFields(carriers: FieldOption[], vehicles: FieldOption[]): FieldSpec[] {
  return [
    { name: 'firstName', labelKey: 'md.f.firstName', kind: 'text', required: true, maxLength: 80 },
    { name: 'lastName', labelKey: 'md.f.lastName', kind: 'text', required: true, maxLength: 80 },
    { name: 'phone', labelKey: 'md.f.phone', kind: 'tel', maxLength: 40, nullable: true },
    { name: 'licenseNumber', labelKey: 'md.f.license', kind: 'text', maxLength: 60, nullable: true, upper: true },
    { name: 'carrierId', labelKey: 'md.f.carrier', kind: 'select', options: carriers, allowEmpty: true, nullable: true },
    {
      name: 'defaultVehicleId',
      labelKey: 'md.f.defaultVehicle',
      kind: 'select',
      options: vehicles,
      allowEmpty: true,
      nullable: true,
    },
  ];
}

/* ------------------------------------------------------------------- products */

export function productFields(categories: FieldOption[]): FieldSpec[] {
  return [
    { name: 'sku', labelKey: 'md.f.sku', kind: 'text', required: true, maxLength: 60, upper: true },
    { name: 'name', labelKey: 'md.f.name', kind: 'text', required: true, minLength: 2, maxLength: 200 },
    { name: 'categoryId', labelKey: 'md.f.category', kind: 'select', options: categories, allowEmpty: true, nullable: true },
    { name: 'barcode', labelKey: 'md.f.barcode', kind: 'text', maxLength: 60, nullable: true },
    { name: 'unitOfMeasure', labelKey: 'md.f.uom', kind: 'text', maxLength: 12, placeholder: 'EA', upper: true },
    { name: 'unitCost', labelKey: 'md.f.unitCost', kind: 'number', required: true, min: 0, hintKey: 'md.h.unitCost' },
    { name: 'unitPrice', labelKey: 'md.f.unitPrice', kind: 'number', required: true, min: 0 },
    { name: 'weightKg', labelKey: 'md.f.weight', kind: 'number', min: 0, nullable: true },
    { name: 'volumeM3', labelKey: 'md.f.volume', kind: 'number', min: 0, nullable: true },
    { name: 'shelfLifeDays', labelKey: 'md.f.shelfLife', kind: 'integer', min: 1, nullable: true, hintKey: 'md.h.shelfLife' },
    {
      name: 'serviceLevel',
      labelKey: 'md.f.serviceLevel',
      kind: 'number',
      min: 0.5,
      max: 0.9999,
      placeholder: '0.95',
      hintKey: 'md.h.serviceLevel',
    },
    { name: 'isPerishable', labelKey: 'md.f.perishable', kind: 'checkbox' },
    { name: 'description', labelKey: 'md.f.description', kind: 'textarea', maxLength: 1000, nullable: true, wide: true },
  ];
}

export function categoryFields(parents: FieldOption[]): FieldSpec[] {
  return [
    { name: 'name', labelKey: 'md.f.categoryName', kind: 'text', required: true, maxLength: 120 },
    { name: 'parentId', labelKey: 'md.f.parent', kind: 'select', options: parents, allowEmpty: true },
  ];
}
