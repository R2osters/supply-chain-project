'use client';

import { Bell, KeyRound, LogOut, Moon, Search, Settings, Sun, Users, WifiOff, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ForcedPasswordChange } from '@/components/account/password-change';
import { CommandPalette } from '@/components/shell/command-palette';
import { UpdateToast } from '@/components/shell/update-toast';
import { Banner, Logo, Provenance } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { LOCALES, useI18n } from '@/lib/i18n';
import { ACCOUNT_NAV, NAV, PILLARS, homeFor, isActive, pageFor, type Pillar } from '@/lib/nav';
import { useTheme } from '@/lib/theme';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut, can } = useAuth();
  const { t, locale, setLocale, intlLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [offlineSince, setOfflineSince] = useState<Date | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  // A page this role may not open (a bookmark, the root redirect, an old link) sends the account
  // to its own home instead of a screen of refusals: a driver never sees the dashboard.
  const page = pageFor(pathname);
  const forbidden = Boolean(user && page?.permission && !can(page.permission));
  useEffect(() => {
    if (forbidden && user) router.replace(homeFor(user.role));
  }, [forbidden, user, router]);

  // Nothing is fetched behind the "choose your password" screen: the API would refuse it all.
  const ready = Boolean(user) && !user?.mustChangePassword;

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api<{ unread: number }>('/notifications/unread-count'),
    enabled: ready,
    refetchInterval: 30_000,
  });

  const { data: aiStatus } = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api<{ reachable: boolean; detail: string }>('/ai/status'),
    enabled: ready,
    refetchInterval: 60_000,
  });

  /* ---------------------------------------------------------- offline state */
  useEffect(() => {
    const goOffline = () => setOfflineSince(new Date());
    const goOnline = () => setOfflineSince(null);
    if (typeof navigator !== 'undefined' && !navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  /* ------------------------------------------------------ global shortcuts */
  const closeAll = useCallback(() => {
    setPaletteOpen(false);
    setHelpOpen(false);
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') {
        closeAll();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '/') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAll]);

  // Close the menus on navigation.
  useEffect(() => {
    closeAll();
  }, [pathname, closeAll]);

  const visible = useMemo(() => NAV.filter((item) => (user ? can(item.permission) : false)), [user, can]);
  const accountPages = useMemo(
    () => ACCOUNT_NAV.filter((item) => (user ? item.permission === null || can(item.permission) : false)),
    [user, can],
  );
  const paletteItems = useMemo(() => [...visible, ...accountPages], [visible, accountPages]);
  const pillars = PILLARS.filter((pillar) => visible.some((item) => item.pillar === pillar.id));
  const current = visible.find((item) => isActive(pathname, item.href));
  const activePillar: Pillar = current?.pillar ?? pillars[0]?.id ?? 'TRACK';
  const modules = visible.filter((item) => item.pillar === activePillar);

  if (loading || !user || forbidden) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <span className="pop text-[var(--color-ink)]">
          <Logo size={40} />
        </span>
        <span className="t-label">{t('nav.establishing')}</span>
      </div>
    );
  }

  // Signed in with a temporary password: the person chooses their own before anything else.
  if (user.mustChangePassword) return <ForcedPasswordChange />;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[color-mix(in_srgb,var(--color-bg)_92%,transparent)] backdrop-blur-md">
        {/* ----------------------------------------------------- row 1: brand */}
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-4 py-2.5 md:gap-4 md:px-8">
          <Link href={homeFor(user.role)} className="flex items-center gap-2 text-[var(--color-ink)]" aria-label="SCIP">
            <Logo size={24} />
            <b className="text-[15px] font-semibold tracking-[0.06em]">SCIP</b>
          </Link>

          <nav aria-label={t('nav.group.track')} className="segmented ml-1 hidden md:inline-flex">
            {pillars.map((pillar) => {
              const Icon = pillar.icon;
              const first = visible.find((item) => item.pillar === pillar.id);
              const active = pillar.id === activePillar;
              return (
                <Link
                  key={pillar.id}
                  href={first?.href ?? '/dashboard'}
                  aria-current={active ? 'page' : undefined}
                  className="uppercase tracking-[0.04em]"
                >
                  <Icon />
                  {t(pillar.labelKey)}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto flex h-9 min-w-0 items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-[13px] text-[var(--color-dim)] transition-colors duration-100 hover:border-[var(--color-muted)] lg:w-[320px]"
            aria-label={t('shell.searchShort')}
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
            <span className="hidden flex-1 truncate text-left lg:inline">{t('shell.search')}</span>
            <span className="kbd hidden lg:inline">/</span>
          </button>

          <div className="hidden items-center gap-3 xl:flex">
            <span title={aiStatus?.reachable ? undefined : t('nav.aiOfflineHint')}>
              <Provenance
                kind={aiStatus?.reachable ? 'live' : 'offline'}
                label={aiStatus?.reachable ? t('nav.aiOnline') : t('nav.aiOffline')}
              />
            </span>
            <span className="pill pill-demo h-7 cursor-help px-3 text-[11px] font-semibold uppercase tracking-[0.06em]" title={t('shell.demoSpaceHint')}>
              {t('shell.demoSpace')}
            </span>
          </div>

          <Link
            href="/notifications"
            className="btn btn-ghost btn-icon relative"
            aria-label={`${t('nav.alerts')}${unread?.unread ? ` (${unread.unread})` : ''}`}
            aria-current={pathname.startsWith('/notifications') ? 'page' : undefined}
          >
            <Bell />
            {unread && unread.unread > 0 && (
              <span
                key={unread.unread}
                className="pop absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-accent)] px-1 font-mono text-[10px] font-semibold text-[var(--color-accent-tx)]"
              >
                {unread.unread > 99 ? '99+' : unread.unread}
              </span>
            )}
          </Link>

          <div className="hidden items-center rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] p-0.5 sm:flex">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLocale(option)}
                aria-pressed={locale === option}
                className={`h-7 rounded-full px-2.5 font-mono text-[11px] font-semibold uppercase transition-colors duration-150 ${
                  locale === option ? 'bg-[var(--color-accent)] text-[var(--color-accent-tx)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleTheme}
            className="btn btn-ghost btn-icon"
            aria-label={`${t('shell.theme')}: ${theme === 'dark' ? t('shell.themeLight') : t('shell.themeDark')}`}
            title={theme === 'dark' ? t('shell.themeLight') : t('shell.themeDark')}
          >
            <span key={theme} className="pop inline-flex">
              {theme === 'dark' ? <Sun /> : <Moon />}
            </span>
          </button>

          <UserMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((open) => !open)}
            name={`${user.firstName} ${user.lastName}`}
            role={user.role.replace(/_/g, ' ').toLowerCase()}
            onSignOut={() => void signOut()}
            signOutLabel={t('nav.signOut')}
            accountLabel={t('shell.account')}
            settingsLabel={can('company:update') ? t('settings.nav') : null}
            usersLabel={can('user:read') ? t('users.nav') : null}
            passwordLabel={t('account.nav')}
          />
        </div>

        {/* -------------------------------------------- row 2: pillar modules */}
        <div className="mx-auto flex max-w-[1680px] items-center gap-2 overflow-x-auto px-4 pb-3 md:px-8 [scrollbar-width:none]">
          {/* On small screens the pillars fold into the module row. */}
          <div className="segmented shrink-0 md:hidden">
            {pillars.map((pillar) => {
              const Icon = pillar.icon;
              const first = visible.find((item) => item.pillar === pillar.id);
              return (
                <Link
                  key={pillar.id}
                  href={first?.href ?? '/dashboard'}
                  aria-current={pillar.id === activePillar ? 'page' : undefined}
                  aria-label={t(pillar.labelKey)}
                >
                  <Icon />
                </Link>
              );
            })}
          </div>
          {modules.map((item, index) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="pill fade-in shrink-0"
                style={{ animationDelay: `${index * 25}ms` }}
              >
                <Icon />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </div>
      </header>

      {offlineSince && (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-4 md:px-8">
          <Banner
            tone="warn"
            icon={WifiOff}
            title={t('shell.offline', {
              time: offlineSince.toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' }),
            })}
          >
            {t('shell.offlineHint')}
          </Banner>
        </div>
      )}

      <main key={pathname} className="mx-auto w-full min-w-0 max-w-[1680px] flex-1 px-4 py-6 md:px-8">
        {children}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
      <UpdateToast />
    </div>
  );
}

function UserMenu({
  open,
  onToggle,
  name,
  role,
  onSignOut,
  signOutLabel,
  accountLabel,
  settingsLabel,
  usersLabel,
  passwordLabel,
}: {
  open: boolean;
  onToggle: () => void;
  name: string;
  role: string;
  onSignOut: () => void;
  signOutLabel: string;
  accountLabel: string;
  /** Null when the user may not change company settings: the entry is hidden, not disabled. */
  settingsLabel: string | null;
  /** Null when the user may not see the company's accounts. */
  usersLabel: string | null;
  /** Everyone may change their own password. */
  passwordLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onToggle();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onToggle]);

  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={accountLabel}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-accent)] text-[12px] font-semibold text-[var(--color-accent-tx)] transition-transform duration-100 active:scale-95"
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          className="slide-up absolute right-0 top-11 z-20 w-60 overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-1.5 shadow-[var(--shadow-md)]"
        >
          <div className="flex flex-col gap-0.5 px-3 py-2.5">
            <b className="truncate font-medium">{name}</b>
            <span className="t-data text-[11px] capitalize text-[var(--color-muted)]">{role}</span>
          </div>
          <div className="my-1 h-px bg-[var(--color-line)]" />
          {usersLabel && (
            <Link
              href="/users"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              <Users className="h-4 w-4 text-[var(--color-muted)]" />
              {usersLabel}
            </Link>
          )}
          {settingsLabel && (
            <Link
              href="/settings"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              <Settings className="h-4 w-4 text-[var(--color-muted)]" />
              {settingsLabel}
            </Link>
          )}
          <Link
            href="/account"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            <KeyRound className="h-4 w-4 text-[var(--color-muted)]" />
            {passwordLabel}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] text-[var(--color-crit)] hover:bg-[var(--color-surface)]"
          >
            <LogOut className="h-4 w-4" />
            {signOutLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const keys: Array<[string, string]> = [
    ['/', t('shell.kb.search')],
    ['⌘K', t('shell.kb.commands')],
    ['J / K', t('shell.kb.next')],
    ['?', t('shell.kb.help')],
    ['Esc', t('shell.kb.close')],
  ];
  return (
    <div
      className="fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.shortcuts')}
        className="slide-up w-full max-w-[420px] rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] p-6 shadow-[var(--shadow-lg)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="t-h3 m-0">{t('shell.shortcuts')}</h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('common.close')}>
            <X />
          </button>
        </div>
        <dl className="m-0 flex flex-col gap-2.5">
          {keys.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <dt className="text-[13px] text-[var(--color-muted)]">{label}</dt>
              <dd className="m-0">
                <span className="kbd">{key}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
