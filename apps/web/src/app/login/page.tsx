'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Anchor, ChevronRight, Moon, Radar, Split, Sun, TrendingUp, type LucideIcon } from 'lucide-react';
import { Banner, Button, Logo } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { LOCALES, useI18n, type TranslationKey } from '@/lib/i18n';
import { homeFor } from '@/lib/nav';
import { useTheme } from '@/lib/theme';
import { FirstRun, useSetupStatus } from './_components/first-run';
import { ForgotPassword } from './_components/forgot-password';

const DEMO_ACCOUNTS: Array<{ email: string; roleKey: TranslationKey; noteKey: TranslationKey }> = [
  { email: 'admin@demo-scip.com', roleKey: 'login.role.admin', noteKey: 'login.note.admin' },
  { email: 'supplychain@demo-scip.com', roleKey: 'login.role.supplychain', noteKey: 'login.note.supplychain' },
  { email: 'logistics@demo-scip.com', roleKey: 'login.role.logistics', noteKey: 'login.note.logistics' },
  { email: 'procurement@demo-scip.com', roleKey: 'login.role.procurement', noteKey: 'login.note.procurement' },
  { email: 'warehouse@demo-scip.com', roleKey: 'login.role.warehouse', noteKey: 'login.note.warehouse' },
  { email: 'driver@demo-scip.com', roleKey: 'login.role.driver', noteKey: 'login.note.driver' },
];

const DEMO_PASSWORD = 'DemoPassw0rd!2026';

const FEATURES: Array<{ icon: LucideIcon; labelKey: TranslationKey; valueKey: TranslationKey }> = [
  { icon: Radar, labelKey: 'login.feature.gps', valueKey: 'login.feature.gpsValue' },
  { icon: Anchor, labelKey: 'login.feature.ais', valueKey: 'login.feature.aisValue' },
  { icon: TrendingUp, labelKey: 'login.feature.forecast', valueKey: 'login.feature.forecastValue' },
  { icon: Split, labelKey: 'login.feature.allocation', valueKey: 'login.feature.allocationValue' },
];

/** How long to trust the client-side navigation before forcing a full page load. */
const NAVIGATION_FALLBACK_MS = 1500;

export default function LoginPage() {
  const router = useRouter();
  const { signIn, user, loading } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();

  const setup = useSetupStatus();
  // Without the status (server build, older API) keep the historical behaviour: demo accounts on.
  const needsSetup = setup.data?.needsSetup === true;
  const showDemo = setup.data ? setup.data.demoAccounts : true;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fallbackTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace(homeFor(user.role));
  }, [loading, user, router]);

  // Pre-fill the demo administrator only when those accounts exist on this install.
  useEffect(() => {
    if (showDemo && !email) {
      setEmail(DEMO_ACCOUNTS[0].email);
      setPassword(DEMO_PASSWORD);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the status arriving
  }, [showDemo]);

  useEffect(
    () => () => {
      if (fallbackTimer.current !== null) window.clearTimeout(fallbackTimer.current);
    },
    [],
  );

  async function enter(accountEmail: string, accountPassword: string) {
    const account = await signIn(accountEmail, accountPassword);
    router.replace(homeFor(account.role));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const account = await signIn(email.trim(), password);
      // Each role opens on a page it may see: a driver on its deliveries, not the dashboard.
      const home = homeFor(account.role);
      router.replace(home);
      // On a cold dev server the first compile of the home page can abort the client navigation
      // and leave a signed-in user staring at the login form. If we are still here after 1.5 s,
      // do a plain page load instead; in production the timer simply never fires.
      fallbackTimer.current = window.setTimeout(() => {
        if (window.location.pathname.startsWith('/login')) window.location.assign(home);
      }, NAVIGATION_FALLBACK_MS);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('login.v3.failed'));
      setBusy(false);
    }
  }

  const ThemeIcon = theme === 'dark' ? Sun : Moon;

  return (
    <main className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      {/* ------------------------------------------------------------ top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-4 md:px-8">
        <span className="pop flex items-center gap-2.5 text-[var(--color-ink)]">
          <Logo size={28} />
          <span className="text-[18px] font-semibold tracking-[0.06em]">{t('app.name')}</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="segmented" role="group" aria-label={t('login.v3.language')}>
            {LOCALES.map((option) => (
              <button key={option} type="button" onClick={() => setLocale(option)} aria-pressed={locale === option}>
                {option.toUpperCase()}
              </button>
            ))}
          </div>
          <Button
            icon={ThemeIcon}
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('login.v3.toLight') : t('login.v3.toDark')}
            title={theme === 'dark' ? t('login.v3.toLight') : t('login.v3.toDark')}
          />
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-[1200px] flex-1 items-center gap-10 px-4 pb-10 md:px-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,440px)] lg:gap-16">
        {/* ---------------------------------------------------------- identity */}
        <section className="stagger flex flex-col gap-6">
          <span className="t-label">{t('login.v3.kicker')}</span>
          <h1 className="m-0 text-[40px] font-normal leading-[1.05] tracking-[-0.015em] [text-wrap:balance] md:text-[56px] xl:text-[64px]">
            {t('app.tagline')}
          </h1>
          <p className="m-0 max-w-[560px] text-[15px] leading-relaxed text-[var(--color-muted)] [text-wrap:pretty]">
            {t('app.description')}
          </p>
          <dl className="m-0 grid grid-cols-2 gap-3 md:max-w-[560px]">
            {FEATURES.map(({ icon: Icon, labelKey, valueKey }) => (
              <div key={labelKey} className="tile flex flex-col gap-1.5 p-4">
                <dt className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-ink)]">
                  <Icon className="h-4 w-4 text-[var(--color-muted)]" />
                  {t(labelKey)}
                </dt>
                <dd className="t-data m-0 text-[12px] text-[var(--color-muted)]">{t(valueKey)}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* -------------------------------------------------------------- form */}
        <section className="rise flex flex-col gap-6 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] p-6 shadow-[var(--shadow-sm)] md:p-8">
          {needsSetup ? (
            <FirstRun
              demoAvailable={setup.data?.demoAvailable ?? false}
              onCreated={enter}
              onDemoLoaded={() => void setup.refetch()}
            />
          ) : (
          <>
          <header className="flex flex-col gap-1">
            <h2 className="t-h2 m-0">{t('login.signIn')}</h2>
            <p className="m-0 text-[13px] text-[var(--color-muted)]">{t('login.v3.subtitle')}</p>
          </header>

          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-[var(--color-muted)]">{t('login.operator')}</span>
              <input
                className="field !h-[42px] !text-[14px]"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[var(--color-muted)]">{t('login.passphrase')}</span>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-[12px] text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
                >
                  {t('login.forgot.link')}
                </button>
              </span>
              <input
                className="field !h-[42px] !text-[14px]"
                type="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={error ? true : undefined}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            {error && <Banner tone="alert" title={t('login.v3.failed')}>{error}</Banner>}

            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              {busy ? t('login.authenticating') : t('login.signIn')}
            </Button>
          </form>

          {forgotOpen && (
            <ForgotPassword
              email={email}
              onClose={() => setForgotOpen(false)}
              onRecovered={(recoveredEmail, temporaryPassword) => {
                setEmail(recoveredEmail);
                setPassword(temporaryPassword);
                setError(null);
                setForgotOpen(false);
              }}
            />
          )}

          {showDemo && (
          <div className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-5">
            <span className="t-label">{t('login.demoAccounts')}</span>
            <ul className="stagger m-0 flex list-none flex-col gap-1 p-0" role="listbox" aria-label={t('login.demoAccounts')}>
              {DEMO_ACCOUNTS.map((account) => {
                const active = email === account.email;
                return (
                  <li key={account.email} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setEmail(account.email);
                        setPassword(DEMO_PASSWORD);
                        setError(null);
                      }}
                      className={`group flex min-h-[40px] w-full items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors duration-100 ${
                        active
                          ? 'bg-[var(--color-accent)] text-[var(--color-accent-tx)]'
                          : 'hover:bg-[var(--color-surface)]'
                      }`}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[13.5px] font-medium">{t(account.roleKey)}</span>
                        <span className={`t-data truncate text-[11px] ${active ? 'opacity-75' : 'text-[var(--color-dim)]'}`}>
                          {account.email}
                        </span>
                      </span>
                      <span className={`flex items-center gap-1 text-[12px] ${active ? 'opacity-80' : 'text-[var(--color-muted)]'}`}>
                        {t(account.noteKey)}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">{t('login.roleNote')}</p>
          </div>
          )}
          </>
          )}
        </section>
      </div>
    </main>
  );
}
