'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { LOCALES, useI18n, type TranslationKey } from '@/lib/i18n';

const DEMO_ACCOUNTS: Array<{ email: string; roleKey: TranslationKey; noteKey: TranslationKey }> = [
  { email: 'admin@demo-scip.com', roleKey: 'login.role.admin', noteKey: 'login.note.admin' },
  { email: 'supplychain@demo-scip.com', roleKey: 'login.role.supplychain', noteKey: 'login.note.supplychain' },
  { email: 'logistics@demo-scip.com', roleKey: 'login.role.logistics', noteKey: 'login.note.logistics' },
  { email: 'procurement@demo-scip.com', roleKey: 'login.role.procurement', noteKey: 'login.note.procurement' },
  { email: 'warehouse@demo-scip.com', roleKey: 'login.role.warehouse', noteKey: 'login.note.warehouse' },
  { email: 'driver@demo-scip.com', roleKey: 'login.role.driver', noteKey: 'login.note.driver' },
];

const DEMO_PASSWORD = 'DemoPassw0rd!2026';

export default function LoginPage() {
  const router = useRouter();
  const { signIn, user, loading } = useAuth();
  const { t, locale, setLocale } = useI18n();

  const [email, setEmail] = useState('admin@demo-scip.com');
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/dashboard');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="deck-surface flex min-h-screen items-center justify-center p-5">
      <div className="grid w-full max-w-4xl gap-px overflow-hidden border border-[var(--color-hairline)] bg-[var(--color-hairline)] md:grid-cols-[1.05fr_1fr]">
        {/* ---------------------------------------------------------- identity */}
        <section className="relative bg-[var(--color-panel)] p-8">
          {/* A faint corridor sketch: the Accra→Kumasi line the whole demo runs on. */}
          <svg
            aria-hidden
            viewBox="0 0 240 320"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.07]"
          >
            <path
              d="M40 290 C 70 250, 60 210, 95 180 S 150 120, 165 60"
              fill="none"
              stroke="var(--color-signal)"
              strokeWidth="1.5"
              strokeDasharray="4 5"
            />
            <circle cx="40" cy="290" r="4" fill="var(--color-signal)" />
            <circle cx="165" cy="60" r="4" fill="var(--color-signal)" />
          </svg>

          <div className="relative">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-lg font-semibold tracking-[0.24em] text-[var(--color-signal)]">
                SCIP
              </span>
              <span className="h-3 w-px bg-[var(--color-hairline-bright)]" />
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
                v0.1
              </span>
            </div>

            <h1 className="mt-7 text-[1.7rem] font-semibold leading-[1.1] tracking-tight">
              {t('app.tagline')}
            </h1>

            <p className="mt-4 max-w-sm text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)]">
              {t('app.description')}
            </p>

            <dl className="mt-8 grid grid-cols-2 gap-px border border-[var(--color-hairline)] bg-[var(--color-hairline)]">
              {(
                [
                  ['login.feature.gps', 'login.feature.gpsValue'],
                  ['login.feature.ais', 'login.feature.aisValue'],
                  ['login.feature.forecast', 'login.feature.forecastValue'],
                  ['login.feature.allocation', 'login.feature.allocationValue'],
                ] as Array<[TranslationKey, TranslationKey]>
              ).map(([labelKey, valueKey]) => (
                <div key={labelKey} className="bg-[var(--color-panel)] px-3 py-2.5">
                  <dt className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
                    {t(labelKey)}
                  </dt>
                  <dd className="mt-0.5 text-[0.75rem] text-[var(--color-ink-dim)]">{t(valueKey)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ------------------------------------------------------------- form */}
        <section className="bg-[var(--color-panel-raised)] p-8">
          <div className="mb-5 flex justify-end gap-1">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLocale(option)}
                aria-pressed={locale === option}
                className={`px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.14em] transition-colors ${
                  locale === option
                    ? 'text-[var(--color-signal)]'
                    : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {t('login.operator')}
              </label>
              <input
                className="field"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {t('login.passphrase')}
              </label>
              <input
                className="field"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            {error && (
              <div className="border border-[var(--color-alert-dim)] bg-[color-mix(in_srgb,var(--color-alert)_8%,transparent)] px-3 py-2 text-[0.75rem] text-[var(--color-alert)]">
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={busy}>
              {busy ? t('login.authenticating') : t('login.signIn')}
            </button>
          </form>

          <div className="mt-7 border-t border-[var(--color-hairline)] pt-5">
            <div className="font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
              {t('login.demoAccounts')}
            </div>
            <ul className="mt-2.5 space-y-px">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(DEMO_PASSWORD);
                    }}
                    className="group flex w-full items-baseline justify-between gap-3 px-1.5 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-signal)_6%,transparent)]"
                  >
                    <span className="font-mono text-[0.6875rem] text-[var(--color-ink-dim)] group-hover:text-[var(--color-signal)]">
                      {t(account.roleKey)}
                    </span>
                    <span className="text-[0.6875rem] text-[var(--color-ink-faint)]">
                      {t(account.noteKey)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
              {t('login.roleNote')}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
