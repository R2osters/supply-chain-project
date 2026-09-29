'use client';

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/lib/i18n';

type ToastTone = 'success' | 'error' | 'info';

interface ToastInput {
  message: ReactNode;
  tone?: ToastTone;
  /** "Undo" rather than "Are you sure?": a reversible action runs at once and offers this. */
  onUndo?: () => void;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  leaving: boolean;
}

const ToastContext = createContext<{ show: (toast: ToastInput) => void } | null>(null);

const ICON = {
  success: <CircleCheck className="h-4 w-4 shrink-0 text-[var(--color-ok)]" />,
  error: <CircleAlert className="h-4 w-4 shrink-0 text-[var(--color-crit)]" />,
  info: <Info className="h-4 w-4 shrink-0 opacity-70" />,
};

/** Charte §07: success + Undo, 6 s, stacked bottom-centre, above everything (z-toast 50). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    window.setTimeout(() => setToasts((all) => all.filter((toast) => toast.id !== id)), 180);
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = ++counter.current;
      setToasts((all) => [...all.slice(-2), { ...input, id, leaving: false }]);
      window.setTimeout(() => dismiss(id), input.durationMs ?? 6000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onClose={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setProgress(0));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto relative flex w-full max-w-[520px] items-center gap-3 overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-ink)] px-4 py-3 text-[var(--color-bg)] shadow-[var(--shadow-md)] ${
        toast.leaving ? 'opacity-0 transition-opacity duration-200' : 'slide-up'
      }`}
    >
      {ICON[toast.tone ?? 'success']}
      <span className="flex-1 text-[13px]">{toast.message}</span>
      {toast.onUndo && (
        <button
          type="button"
          onClick={() => {
            toast.onUndo?.();
            onClose();
          }}
          className="text-[13px] font-semibold underline underline-offset-2"
        >
          {t('common.undo')}
        </button>
      )}
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onClose();
          }}
          className="text-[13px] font-semibold underline underline-offset-2"
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" onClick={onClose} aria-label={t('common.close')} className="opacity-60 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-[2px] w-full origin-left bg-current opacity-25"
        style={{
          transform: `scaleX(${progress})`,
          transition: `transform ${toast.durationMs ?? 6000}ms linear`,
        }}
      />
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
