import type { TranslationKey } from './i18n';

/**
 * Field-spec–driven forms for the master-data screens (suppliers, products, warehouses, fleet,
 * customers, carriers).
 *
 * The API validates every body with `whitelist + forbidNonWhitelisted`, so a form that sends a
 * field the DTO does not declare is rejected outright. The spec is therefore the single list of
 * what a form may send, and the rules on each field mirror the DTO's class-validator decorators
 * so the operator hears about a bad value before the round trip, not after it.
 *
 * Pure on purpose: validation and payload building are unit-tested without a DOM.
 */

export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'textarea'
  | 'number'
  | 'integer'
  | 'select'
  | 'checkbox';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  /** Exact DTO property name. */
  name: string;
  labelKey: TranslationKey;
  kind: FieldKind;
  hintKey?: TranslationKey;
  placeholder?: string;
  /** `@IsOptional()` absent on the create DTO. */
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /**
   * The Prisma column is nullable, so clearing the field on edit sends `null` (which
   * `@IsOptional()` accepts) and the stored value is erased. Non-nullable columns with a default
   * are simply left out when blank.
   */
  nullable?: boolean;
  /** This field becomes required once the named one is filled (a latitude needs its longitude). */
  requiredWith?: string;
  /** Options for `select`; an empty value means "none". */
  options?: FieldOption[];
  /** Offer an empty "—" option on a select even when the field is required-free. */
  allowEmpty?: boolean;
  /** Two-column grid: `full` spans both. */
  wide?: boolean;
  /** Upper-case the value as it is typed (codes, plates, ISO currency). */
  upper?: boolean;
  /** Only sent on create; left out of an edit payload. */
  createOnly?: boolean;
}

export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export type FieldErrorCode =
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'integer'
  | 'number'
  | 'option';

export interface FieldError {
  code: FieldErrorCode;
  /** The limit that was crossed, for the message. */
  n?: number;
}

export type FormErrors = Record<string, FieldError>;

function isBlank(value: FormValue | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Parses a number typed by a human: tolerates a decimal comma, rejects anything else. */
export function parseNumber(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (text === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** First error per field, in spec order. An empty object means the form can be submitted. */
export function validateForm(fields: readonly FieldSpec[], values: FormValues): FormErrors {
  const errors: FormErrors = {};

  for (const field of fields) {
    const value = values[field.name];

    if (field.kind === 'checkbox') continue;

    const blank = isBlank(value);
    const partnerFilled = field.requiredWith ? !isBlank(values[field.requiredWith]) : false;
    if (blank) {
      if (field.required || partnerFilled) errors[field.name] = { code: 'required' };
      continue;
    }

    const text = String(value).trim();

    if (field.kind === 'number' || field.kind === 'integer') {
      const parsed = parseNumber(text);
      if (parsed === null) {
        errors[field.name] = { code: 'number' };
        continue;
      }
      if (field.kind === 'integer' && !Number.isInteger(parsed)) {
        errors[field.name] = { code: 'integer' };
        continue;
      }
      if (field.min !== undefined && parsed < field.min) {
        errors[field.name] = { code: 'min', n: field.min };
        continue;
      }
      if (field.max !== undefined && parsed > field.max) {
        errors[field.name] = { code: 'max', n: field.max };
      }
      continue;
    }

    if (field.kind === 'select') {
      // Optional look-ups (carrier, category…) may point at a row that has since been archived
      // and so is missing from the loaded options; only closed lists are checked.
      if (!field.allowEmpty && field.options && !field.options.some((option) => option.value === text)) {
        errors[field.name] = { code: 'option' };
      }
      continue;
    }

    if (field.minLength !== undefined && text.length < field.minLength) {
      errors[field.name] = { code: 'minLength', n: field.minLength };
      continue;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      errors[field.name] = { code: 'maxLength', n: field.maxLength };
    }
  }

  return errors;
}

/**
 * The request body for a create (POST) or an edit (PATCH).
 *
 * - Strings are trimmed; numbers are sent as numbers (the API's implicit conversion is off).
 * - A blank optional field is omitted on create. On edit it becomes `null` when the column is
 *   nullable — the only way to clear it — and is omitted otherwise, keeping the stored default.
 * - Only fields in the spec are ever sent, which is what `forbidNonWhitelisted` demands.
 */
export function buildPayload(
  fields: readonly FieldSpec[],
  values: FormValues,
  mode: 'create' | 'edit',
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const field of fields) {
    if (mode === 'edit' && field.createOnly) continue;
    const value = values[field.name];

    if (field.kind === 'checkbox') {
      body[field.name] = value === true;
      continue;
    }

    if (isBlank(value)) {
      if (mode === 'edit' && field.nullable) body[field.name] = null;
      continue;
    }

    const text = String(value).trim();
    if (field.kind === 'number' || field.kind === 'integer') {
      const parsed = parseNumber(text);
      if (parsed !== null) body[field.name] = parsed;
      continue;
    }
    body[field.name] = field.upper ? text.toUpperCase() : text;
  }

  return body;
}

/**
 * Form state from a record the API returned. Prisma serialises `Decimal` columns as strings and
 * nullable columns as `null`; both land as editable text.
 */
export function toFormValues(
  fields: readonly FieldSpec[],
  record?: Record<string, unknown> | null,
): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const raw = record?.[field.name];
    if (field.kind === 'checkbox') {
      values[field.name] = raw === true;
    } else if (raw === null || raw === undefined) {
      values[field.name] = '';
    } else if (typeof raw === 'number' || typeof raw === 'string') {
      values[field.name] = String(raw);
    } else {
      values[field.name] = '';
    }
  }
  return values;
}

/** Minutes from midnight ↔ "HH:MM", for customer delivery windows. */
export function minutesToClock(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
