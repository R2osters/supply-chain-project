'use client';

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CircleAlert, Save, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  buildPayload,
  toFormValues,
  validateForm,
  type FieldError,
  type FieldSpec,
  type FormErrors,
  type FormValues,
} from '@/lib/entity-form';
import { useI18n } from '@/lib/i18n';
import { useToast } from './toast';
import { Banner, Button } from './ui';

/* ============================================================================
   Master-data editing kit: a side drawer, a spec-driven form and a confirm
   dialog. Every create / edit / delete screen for reference data is built from
   these three so validation, focus handling and error display stay identical.
   ========================================================================== */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open dialogs, innermost last: only the top one answers Escape and traps Tab. */
const dialogStack: object[] = [];

/** Escape closes, Tab stays inside, focus returns to the opener on close. */
function useDialogFocus(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // The first field, not the close button, so typing can start at once.
    const first =
      node?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ??
      node?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();

    const token = {};
    dialogStack.push(token);

    const onKey = (event: KeyboardEvent): void => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = Array.from(
        ref.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const head = focusable[0];
      const tail = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      opener?.focus?.();
    };
  }, [ref]);
}

/* ------------------------------------------------------------------- drawer */

export function Drawer({
  kicker,
  title,
  onClose,
  children,
  width = 560,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useDialogFocus(panel, onClose);

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <div
        className="fade-in absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_28%,transparent)]"
        onClick={onClose}
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="slide-in-right absolute inset-y-0 right-0 flex w-full flex-col overflow-y-auto bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
          <div className="flex min-w-0 flex-col gap-1">
            {kicker && <span className="t-label">{kicker}</span>}
            <h2 id={titleId} className="t-h2 m-0 truncate">
              {title}
            </h2>
          </div>
          <Button variant="ghost" icon={X} onClick={onClose} aria-label={t('common.close')} />
        </header>
        <div className="flex flex-col gap-6 px-6 pb-8 pt-2">{children}</div>
      </aside>
    </div>
  );
}

/* --------------------------------------------------------------------- form */

export function useFieldErrorText() {
  const { t } = useI18n();
  return (error: FieldError): string => {
    switch (error.code) {
      case 'required':
        return t('md.err.required');
      case 'minLength':
        return t('md.err.minLength', { n: error.n ?? 0 });
      case 'maxLength':
        return t('md.err.maxLength', { n: error.n ?? 0 });
      case 'min':
        return t('md.err.min', { n: error.n ?? 0 });
      case 'max':
        return t('md.err.max', { n: error.n ?? 0 });
      case 'integer':
        return t('md.err.integer');
      case 'option':
        return t('md.err.option');
      default:
        return t('md.err.number');
    }
  };
}

/**
 * A form rendered from a field spec. Client-side rules mirror the DTO; the server's answer,
 * when it still refuses, is shown in a banner above the buttons without losing what was typed.
 */
export function EntityForm({
  fields,
  initial,
  mode,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  resetOnSuccess = false,
  successTick = 0,
  onChange,
}: {
  fields: readonly FieldSpec[];
  initial?: Record<string, unknown> | null;
  mode: 'create' | 'edit';
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel?: () => void;
  /** Clear the form after each success (inline "add another" forms). */
  resetOnSuccess?: boolean;
  /** Incremented by the parent when a submission succeeded. */
  successTick?: number;
  /**
   * Every edit, for specs that depend on a value (a field that only applies to one role). The
   * form keeps what was typed when the parent then passes a different `fields` list.
   */
  onChange?: (values: FormValues) => void;
}) {
  const { t } = useI18n();
  const errorText = useFieldErrorText();
  const formId = useId();
  const [values, setValues] = useState<FormValues>(() => toFormValues(fields, initial));
  const [errors, setErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (resetOnSuccess && successTick > 0) {
      setValues(toFormValues(fields, null));
      setErrors({});
      setTouched(false);
    }
    // Only a new success resets; a spec change (options loaded) must not wipe typed values.
  }, [successTick]); // eslint-disable-line

  const set = (name: string, value: string | boolean) => {
    const next = { ...values, [name]: value };
    setValues(next);
    if (touched) setErrors(validateForm(fields, next));
    onChange?.(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateForm(fields, values);
    setErrors(found);
    setTouched(true);
    const firstBad = fields.find((field) => found[field.name]);
    if (firstBad) {
      document.getElementById(`${formId}-${firstBad.name}`)?.focus();
      return;
    }
    onSubmit(buildPayload(fields, values, mode));
  };

  const errorCount = Object.keys(errors).length;

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `${formId}-${field.name}`;
          const fieldError = errors[field.name];
          const describedBy = [fieldError ? `${id}-err` : null, field.hintKey ? `${id}-hint` : null]
            .filter(Boolean)
            .join(' ');
          const value = values[field.name];
          const common = {
            id,
            name: field.name,
            'aria-invalid': fieldError ? true : undefined,
            'aria-describedby': describedBy || undefined,
            'aria-required': field.required || undefined,
          } as const;

          if (field.kind === 'checkbox') {
            return (
              <div key={field.name} className={field.wide ? 'sm:col-span-2' : ''}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-[13px]">
                  <input
                    {...common}
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) => set(field.name, event.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  {t(field.labelKey)}
                </label>
                {field.hintKey && (
                  <span id={`${id}-hint`} className="text-[12px] text-[var(--color-muted)]">
                    {t(field.hintKey)}
                  </span>
                )}
              </div>
            );
          }

          const text = typeof value === 'string' ? value : '';
          let control: ReactNode;
          if (field.kind === 'select') {
            const options = field.options ?? [];
            const known = text === '' || options.some((option) => option.value === text);
            control = (
              <select {...common} className="field" value={text} onChange={(event) => set(field.name, event.target.value)}>
                {(field.allowEmpty || !field.required || text === '') && (
                  <option value="">{field.allowEmpty ? `— ${t('common.none')} —` : t('md.pick')}</option>
                )}
                {!known && <option value={text}>{text}</option>}
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            );
          } else if (field.kind === 'textarea') {
            control = (
              <textarea
                {...common}
                className="field"
                rows={3}
                maxLength={field.maxLength}
                value={text}
                placeholder={field.placeholder}
                onChange={(event) => set(field.name, event.target.value)}
              />
            );
          } else {
            const numeric = field.kind === 'number' || field.kind === 'integer';
            control = (
              <input
                {...common}
                className={`field ${numeric || field.upper ? 't-data' : ''}`}
                type={field.kind === 'email' ? 'email' : field.kind === 'tel' ? 'tel' : 'text'}
                inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'number' ? 'decimal' : undefined}
                autoComplete="off"
                maxLength={numeric ? undefined : field.maxLength}
                value={text}
                placeholder={field.placeholder}
                onChange={(event) => set(field.name, field.upper ? event.target.value.toUpperCase() : event.target.value)}
              />
            );
          }

          return (
            <div key={field.name} className={`flex flex-col gap-1.5 ${field.wide ? 'sm:col-span-2' : ''}`}>
              <label htmlFor={id} className="text-[12.5px] font-medium text-[var(--color-ink)]">
                {t(field.labelKey)}
                {field.required ? (
                  <span aria-hidden className="text-[var(--color-muted)]">
                    {' '}
                    *
                  </span>
                ) : null}
              </label>
              {control}
              {fieldError ? (
                <span id={`${id}-err`} className="flex items-center gap-1.5 text-[12px] text-[var(--color-crit)]">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                  {errorText(fieldError)}
                </span>
              ) : field.hintKey ? (
                <span id={`${id}-hint`} className="text-[12px] text-[var(--color-muted)]">
                  {t(field.hintKey)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {errorCount > 0 && (
        <p className="m-0 text-[12.5px] text-[var(--color-muted)]" role="status">
          {t('md.fixErrors', { n: errorCount })}
        </p>
      )}

      {Boolean(error) && (
        <Banner tone="alert" icon={CircleAlert} title={t('md.saveFailed')}>
          {errorMessage(error)}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" icon={Save} loading={pending}>
          {submitLabel}
        </Button>
        {onCancel && <Button onClick={onCancel}>{t('common.cancel')}</Button>}
        <span className="ml-auto text-[12px] text-[var(--color-dim)]">{t('md.requiredNote')}</span>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ confirm */

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onCancel,
  confirmIcon = Trash2,
  errorTitle,
}: {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  pending: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm button's icon; a bin unless the action is not a deletion. */
  confirmIcon?: LucideIcon;
  /** Title of the refusal banner; "could not delete" unless the action is not a deletion. */
  errorTitle?: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, onCancel);

  return (
    <div
      className="fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="slide-up flex w-full max-w-[440px] flex-col gap-4 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="t-h3 m-0">
          {title}
        </h2>
        {body && <div className="text-[13px] leading-relaxed text-[var(--color-muted)]">{body}</div>}
        {Boolean(error) && (
          <Banner tone="alert" icon={CircleAlert} title={errorTitle ?? t('md.deleteFailed')}>
            {errorMessage(error)}
          </Banner>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="destructive" icon={confirmIcon} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- crud */

/**
 * Create / update / delete against one REST collection, invalidating every query that starts
 * with one of `invalidate` so lists elsewhere in the app (map, routing, allocation…) refresh too.
 */
export function useCrud<Row extends { id: string }>({
  base,
  invalidate,
  messages,
}: {
  base: string;
  invalidate: QueryKey[];
  messages: { created: (row: Row) => string; updated: (row: Row) => string; deleted: string };
}) {
  const client = useQueryClient();
  const toast = useToast();

  const refresh = () => {
    for (const key of invalidate) void client.invalidateQueries({ queryKey: key });
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Row>(base, { method: 'POST', body }),
    onSuccess: (row) => {
      refresh();
      toast.show({ message: messages.created(row) });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Row>(`${base}/${id}`, { method: 'PATCH', body }),
    onSuccess: (row) => {
      refresh();
      toast.show({ message: messages.updated(row) });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      toast.show({ message: messages.deleted });
    },
  });

  return { create, update, remove };
}
