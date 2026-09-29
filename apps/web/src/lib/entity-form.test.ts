import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  minutesToClock,
  parseNumber,
  toFormValues,
  validateForm,
  type FieldSpec,
} from './entity-form';
import {
  CARRIER_FIELDS,
  CUSTOMER_FIELDS,
  LOCATION_FIELDS,
  SUPPLIER_FIELDS,
  WAREHOUSE_FIELDS,
  categoryFields,
  driverFields,
  productFields,
  supplierProductFields,
  vehicleFields,
} from './master-data-fields';

const label = (key: string) => key;

describe('parseNumber', () => {
  it('accepts plain, signed, decimal-comma and exponent numbers', () => {
    expect(parseNumber('12')).toBe(12);
    expect(parseNumber(' -0.187 ')).toBe(-0.187);
    expect(parseNumber('5,6037')).toBe(5.6037);
    expect(parseNumber('1e3')).toBe(1000);
    expect(parseNumber('.5')).toBe(0.5);
  });

  it('rejects anything that is not a number', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('12abc')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
  });
});

describe('validateForm', () => {
  it('flags required, length and numeric range the way the DTO does', () => {
    const errors = validateForm(WAREHOUSE_FIELDS, {
      code: '',
      name: 'A',
      country: 'GH',
      latitude: '95',
      longitude: 'east',
      geofenceRadiusM: '10',
    });
    expect(errors.code).toEqual({ code: 'required' });
    expect(errors.name).toEqual({ code: 'minLength', n: 2 });
    expect(errors.latitude).toEqual({ code: 'max', n: 90 });
    expect(errors.longitude).toEqual({ code: 'number' });
    expect(errors.geofenceRadiusM).toEqual({ code: 'min', n: 25 });
    expect(errors.country).toBeUndefined();
  });

  it('rejects decimals in integer fields', () => {
    const errors = validateForm(SUPPLIER_FIELDS, {
      code: 'SUP-1',
      name: 'Volta',
      country: 'GH',
      quotedLeadTimeDays: '7.5',
    });
    expect(errors).toEqual({ quotedLeadTimeDays: { code: 'integer' } });
  });

  it('enforces max lengths', () => {
    const errors = validateForm(SUPPLIER_FIELDS, { code: 'X', name: 'Volta', country: 'GH', currency: 'CEDI' });
    expect(errors.currency).toEqual({ code: 'maxLength', n: 3 });
  });

  it('asks for the other coordinate once one is filled', () => {
    const errors = validateForm(CUSTOMER_FIELDS, { code: 'C1', name: 'Kumasi', country: 'GH', latitude: '6.7' });
    expect(errors).toEqual({ longitude: { code: 'required' } });
    expect(validateForm(CUSTOMER_FIELDS, { code: 'C1', name: 'Kumasi', country: 'GH' })).toEqual({});
  });

  it('keeps closed selects to their list but tolerates archived look-ups', () => {
    const fields = vehicleFields([{ value: 'car1', label: 'Carrier' }], label);
    const errors = validateForm(fields, {
      plateNumber: 'GT-1',
      type: 'SPACESHIP',
      capacityUnits: '10',
      carrierId: 'archived-carrier',
    });
    expect(errors).toEqual({ type: { code: 'option' } });
  });

  it('bounds the product service level strictly below 1', () => {
    const fields = productFields([]);
    const base = { sku: 'SKU-1', name: 'Flour', unitCost: '1', unitPrice: '2' };
    expect(validateForm(fields, { ...base, serviceLevel: '1' }).serviceLevel).toEqual({ code: 'max', n: 0.9999 });
    expect(validateForm(fields, { ...base, serviceLevel: '0.4' }).serviceLevel).toEqual({ code: 'min', n: 0.5 });
    expect(validateForm(fields, { ...base, serviceLevel: '0.95' })).toEqual({});
  });
});

describe('buildPayload', () => {
  it('sends numbers as numbers, trims strings and omits blanks on create', () => {
    const body = buildPayload(
      productFields([]),
      {
        sku: ' sku-1 ',
        name: ' Sorghum flour ',
        categoryId: '',
        unitCost: '12,5',
        unitPrice: '20',
        shelfLifeDays: '',
        isPerishable: true,
        description: '',
      },
      'create',
    );
    expect(body).toEqual({ sku: 'SKU-1', name: 'Sorghum flour', unitCost: 12.5, unitPrice: 20, isPerishable: true });
  });

  it('clears nullable columns with null on edit and leaves defaulted ones alone', () => {
    const body = buildPayload(
      productFields([]),
      { sku: 'SKU-1', name: 'Flour', unitCost: '1', unitPrice: '2', barcode: '', unitOfMeasure: '', isPerishable: false },
      'edit',
    );
    expect(body.barcode).toBeNull();
    expect('unitOfMeasure' in body).toBe(false);
    expect(body.isPerishable).toBe(false);
  });

  it('never sends a property outside the spec (the API forbids unknown fields)', () => {
    const body = buildPayload(CARRIER_FIELDS, { code: 'c', name: 'Carrier', country: 'gh', id: 'x', isActive: true }, 'create');
    expect(Object.keys(body).sort()).toEqual(['code', 'country', 'name']);
    expect(body).toEqual({ code: 'C', name: 'Carrier', country: 'GH' });
  });

  it('skips create-only fields on edit', () => {
    const fields: FieldSpec[] = [
      { name: 'a', labelKey: 'md.f.code', kind: 'text', createOnly: true },
      { name: 'b', labelKey: 'md.f.name', kind: 'text' },
    ];
    expect(buildPayload(fields, { a: 'x', b: 'y' }, 'edit')).toEqual({ b: 'y' });
    expect(buildPayload(fields, { a: 'x', b: 'y' }, 'create')).toEqual({ a: 'x', b: 'y' });
  });

  it('builds a supplier–product link body matching UpsertSupplierProductDto', () => {
    const body = buildPayload(
      supplierProductFields([{ value: 'p1', label: 'P1' }]),
      { productId: 'p1', unitPrice: '10.5', currency: '', minimumOrderQuantity: '', capacityPerCycle: '500', leadTimeDays: '7' },
      'create',
    );
    expect(body).toEqual({ productId: 'p1', unitPrice: 10.5, capacityPerCycle: 500, leadTimeDays: 7 });
  });
});

describe('toFormValues', () => {
  it('turns API records (Decimal strings, nulls) into editable text', () => {
    const values = toFormValues(productFields([]), {
      sku: 'SKU-1',
      unitCost: '12.5000',
      weightKg: null,
      shelfLifeDays: 30,
      isPerishable: true,
      category: { id: 'c1' },
    });
    expect(values.sku).toBe('SKU-1');
    expect(values.unitCost).toBe('12.5000');
    expect(values.weightKg).toBe('');
    expect(values.shelfLifeDays).toBe('30');
    expect(values.isPerishable).toBe(true);
    expect(values.name).toBe('');
  });

  it('round-trips an edit without changing untouched values', () => {
    const record = { code: 'WH-1', name: 'Accra DC', country: 'GH', latitude: 5.6, longitude: -0.18, geofenceRadiusM: 300 };
    const body = buildPayload(WAREHOUSE_FIELDS, toFormValues(WAREHOUSE_FIELDS, record), 'edit');
    expect(body).toMatchObject(record);
    expect(body.city).toBeNull();
  });
});

describe('field specs', () => {
  it('match the DTO property names', () => {
    const names = (fields: FieldSpec[]) => fields.map((field) => field.name).sort();
    expect(names(SUPPLIER_FIELDS)).toEqual(
      [
        'code', 'name', 'country', 'city', 'addressLine', 'contactName', 'contactEmail', 'contactPhone',
        'latitude', 'longitude', 'quotedLeadTimeDays', 'paymentTerms', 'currency',
      ].sort(),
    );
    expect(names(driverFields([], []))).toEqual(
      ['firstName', 'lastName', 'phone', 'licenseNumber', 'carrierId', 'defaultVehicleId'].sort(),
    );
    expect(names(LOCATION_FIELDS)).toEqual(['code', 'zone', 'aisle', 'rack', 'shelf'].sort());
    expect(names(categoryFields([]))).toEqual(['name', 'parentId']);
    expect(names(vehicleFields([], label))).toEqual(
      [
        'plateNumber', 'label', 'type', 'status', 'carrierId', 'capacityUnits', 'capacityKg',
        'fuelConsumptionLPer100Km', 'costPerKm', 'nominalSpeedKmh',
      ].sort(),
    );
  });
});

describe('minutesToClock', () => {
  it('formats minutes after midnight', () => {
    expect(minutesToClock(480)).toBe('08:00');
    expect(minutesToClock(1080)).toBe('18:00');
    expect(minutesToClock(1440)).toBe('24:00');
    expect(minutesToClock(null)).toBe('—');
  });
});
