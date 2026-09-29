'use client';

import { Check, Copy, KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import { Banner, Button } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

interface RecoveredAccount {
  email: string;
  temporaryPassword: string;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The desktop shell's command bridge, when this page runs inside SCIP's own window. */
function desktopInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke ?? null;
}

interface ForgotPasswordProps {
  email: string;
  /** Puts the recovered credentials into the sign-in form. */
  onRecovered: (email: string, temporaryPassword: string) => void;
  onClose: () => void;
}

/**
 * "Mot de passe oublié ?" — there is no e-mail on a desktop install, so:
 * - in SCIP's own window, this computer can give an administrator a temporary password (the
 *   desktop shell holds a local recovery token; the password must be changed at sign-in);
 * - anywhere else (a driver's phone on the Wi-Fi), an administrator resets it from Utilisateurs.
 */
export function ForgotPassword({ email, onRecovered, onClose }: ForgotPasswordProps) {
  const { t } = useI18n();
  const invoke = desktopInvoke();
  const [target, setTarget] = useState(email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveredAccount | null>(null);
  const [copied, setCopied] = useState(false);

  async function recover() {
    if (!invoke) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await invoke<RecoveredAccount>('recover_admin_password', { email: target.trim() || null }));
    } catch (caught) {
      setError(typeof caught === 'string' ? caught : t('login.forgot.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
    } catch {
      // Clipboard can be refused; the password stays visible and selectable.
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-line)] p-4">
      <header className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <KeyRound className="h-4 w-4" />
          {t('login.forgot.title')}
        </span>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label={t('common.close')} />
      </header>

      {!invoke ? (
        <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('login.forgot.askAdmin')}</p>
      ) : result ? (
        <>
          <Banner tone="ok" title={t('login.forgot.doneTitle', { email: result.email })}>
            {t('login.forgot.doneBody')}
          </Banner>
          <span className="flex items-center gap-2">
            <code className="t-data flex-1 select-all rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-3 py-2 text-[15px] tracking-[0.04em]">
              {result.temporaryPassword}
            </code>
            <Button icon={copied ? Check : Copy} onClick={() => void copy()}>
              {copied ? t('login.forgot.copied') : t('login.forgot.copy')}
            </Button>
          </span>
          <Button variant="primary" onClick={() => onRecovered(result.email, result.temporaryPassword)}>
            {t('login.forgot.useIt')}
          </Button>
        </>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">{t('login.forgot.desktopLead')}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-[var(--color-muted)]">{t('login.forgot.email')}</span>
            <input
              className="field !h-[40px] !text-[14px]"
              type="email"
              value={target}
              placeholder={t('login.forgot.emailPlaceholder')}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          {error && <Banner tone="alert" title={t('login.forgot.failed')}>{error}</Banner>}
          <Button variant="primary" loading={busy} onClick={() => void recover()}>
            {t('login.forgot.submit')}
          </Button>
        </>
      )}
    </div>
  );
}
