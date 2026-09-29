'use client';

import { Circle, CircleAlert, CircleCheck, KeyRound, LogOut } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { checkPasswordChange, type PasswordChangeCheck } from '@/lib/password-rules';
import { useToast } from '../toast';
import { Banner, Button, Logo } from '../ui';

/* ============================================================================
   Changing one's own password: the form with its live rules, used by
   "Mon mot de passe" and by the blocking screen shown after a sign-in with a
   temporary password.
   ========================================================================== */

function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CircleCheck : Circle;
  return (
    <li className={`flex items-start gap-2 text-[12.5px] ${ok ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'}`}>
      <Icon
        className="mt-[1px] h-3.5 w-3.5 shrink-0"
        style={{ color: ok ? 'var(--color-ok)' : 'var(--color-dim)' }}
        aria-hidden
      />
      <span>{children}</span>
    </li>
  );
}

/** The API's rule, ticked off as the person types (same rule, see lib/password-rules.ts). */
export function PasswordChecklist({ check, id }: { check: PasswordChangeCheck; id?: string }) {
  const { t } = useI18n();
  const kinds: Array<[boolean, string]> = [
    [check.lower, t('pwd.rule.lower')],
    [check.upper, t('pwd.rule.upper')],
    [check.digit, t('pwd.rule.digit')],
    [check.symbol, t('pwd.rule.symbol')],
  ];
  return (
    <ul id={id} aria-label={t('pwd.rules')} className="m-0 flex list-none flex-col gap-1.5 p-0">
      <Rule ok={check.length}>{t('pwd.rule.length')}</Rule>
      <Rule ok={check.mix}>
        {t('pwd.rule.mix')}{' '}
        {kinds.map(([present, label], index) => (
          <span key={label}>
            <span className={present ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-dim)]'}>{label}</span>
            {index < kinds.length - 1 ? ' · ' : ''}
          </span>
        ))}
      </Rule>
      <Rule ok={check.differs}>{t('pwd.rule.differs')}</Rule>
      <Rule ok={check.matches}>{t('pwd.rule.match')}</Rule>
      {!check.notTooLong && (
        <li className="flex items-center gap-2 text-[12.5px] text-[var(--color-crit)]">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('pwd.rule.tooLong')}
        </li>
      )}
    </ul>
  );
}

/**
 * Current password, new one, confirmation. Sent only once the rules hold, so the API's refusal is
 * the rare case (a wrong current password) rather than the way people learn the rules.
 */
export function PasswordChangeForm({ forced = false, onChanged }: { forced?: boolean; onChanged?: () => void }) {
  const { t } = useI18n();
  const { user, changePassword } = useAuth();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = checkPasswordChange(current, next, confirm);
  const label = 'text-[12.5px] font-medium text-[var(--color-ink)]';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!check.ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {/* Lets a password manager file the new password under the right account. */}
      <input type="email" name="username" autoComplete="username" value={user?.email ?? ''} readOnly hidden />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-current`} className={label}>
          {forced ? t('pwd.temporary') : t('pwd.current')}
        </label>
        <input
          id={`${id}-current`}
          className="field"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-new`} className={label}>
          {t('pwd.new')}
        </label>
        <input
          id={`${id}-new`}
          className="field"
          type="password"
          autoComplete="new-password"
          value={next}
          aria-describedby={`${id}-rules`}
          aria-invalid={next.length > 0 && !check.valid ? true : undefined}
          onChange={(event) => setNext(event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-confirm`} className={label}>
          {t('pwd.confirm')}
        </label>
        <input
          id={`${id}-confirm`}
          className="field"
          type="password"
          autoComplete="new-password"
          value={confirm}
          aria-invalid={confirm.length > 0 && !check.matches ? true : undefined}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
      </div>

      <PasswordChecklist check={check} id={`${id}-rules`} />

      {error && (
        <Banner tone="alert" icon={CircleAlert} title={t('pwd.failed')}>
          {error}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!check.ready}>
          {forced ? t('pwd.forced.submit') : t('pwd.submit')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Shown by the app shell instead of any screen while the account holds a temporary password
 * (`mustChangePassword`): the API refuses everything else until then, so there is nothing
 * behind it to reach. Signing out is the only other way out.
 */
export function ForcedPasswordChange() {
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const toast = useToast();
  const titleId = useId();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-bg)] px-4 py-10">
      <section
        aria-labelledby={titleId}
        className="rise flex w-full max-w-[460px] flex-col gap-6 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] p-6 shadow-[var(--shadow-sm)] md:p-8"
      >
        <header className="flex flex-col gap-2">
          <span className="mb-2 flex items-center gap-2 text-[var(--color-ink)]">
            <Logo size={24} />
            <b className="text-[15px] font-semibold tracking-[0.06em]">SCIP</b>
          </span>
          <span className="t-label">{t('pwd.forced.kicker')}</span>
          <h1 id={titleId} className="t-h2 m-0">
            {t('pwd.forced.title')}
          </h1>
          <p className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)] [text-wrap:pretty]">
            {t('pwd.forced.body')}
          </p>
          {user && <span className="t-data text-[12px] text-[var(--color-dim)]">{t('pwd.forced.as', { email: user.email })}</span>}
        </header>

        <PasswordChangeForm
          forced
          onChanged={() => toast.show({ tone: 'success', message: t('account.changed') })}
        />

        <div className="border-t border-[var(--color-line)] pt-4">
          <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void signOut()}>
            {t('nav.signOut')}
          </Button>
        </div>
      </section>
    </main>
  );
}
