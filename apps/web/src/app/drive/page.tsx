'use client';

/**
 * The driver's screen: the €0 way to put a truck on the map.
 *
 * Deliberately outside the authenticated shell. A driver is not an operator — they have no
 * account, no sidebar, no dashboard, and they are holding a phone in one hand at a loading bay.
 * The screen has one control and reports one thing.
 *
 * Authentication is the device identifier plus its pairing secret, not a user session, because an
 * access token expires in fifteen minutes and a phone in a coverage gap cannot refresh one —
 * which is precisely where tracking matters most. The credential is long-lived and revocable from
 * the devices screen, which is the right shape for something that has to survive four hours of no
 * signal.
 *
 * What this honestly cannot do: keep reporting once the page is hidden. A mobile browser
 * suspends timers and geolocation watches for a backgrounded tab — iOS Safari immediately,
 * Android Chrome within a minute or two. There is no way around it from a web page; a native app
 * with a foreground service is the only fix. So the screen says so plainly, holds a wake lock to
 * stop the display sleeping, and keeps every fix taken so far in IndexedDB so the track has no
 * hole when the driver comes back to it. Claiming background tracking here would be a lie the
 * dispatcher would only discover from an empty map.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BatteryCharging, Moon, Play, Square, Sun, TriangleAlert, WifiOff } from 'lucide-react';
import { Banner, Logo, Provenance, type ProvenanceKind } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { clear, count, drop, enqueue, peek, trim, type BufferedFix } from '@/lib/drive-buffer';
import { apiUrl } from '@/lib/runtime-config';

const CREDENTIAL_KEY = 'scip.drive.credential';

/** How often to flush. Short enough that the map is current, long enough to batch a few fixes. */
const FLUSH_INTERVAL_MS = 30_000;

/** The server accepts 500 per request; staying well under keeps a flush quick on a weak signal. */
const BATCH_SIZE = 200;

interface Credential {
  identifier: string;
  secret: string;
}

type DriveTheme = 'light' | 'dark';
const THEME_KEY = 'scip.drive.theme';

/**
 * Full sun on a windscreen washes out grey-on-grey. In day mode the screen drops the product's
 * soft greys for ink on pure white and darker secondary text; night mode keeps the regular dark
 * tokens, which are already high-contrast and do not dazzle a driver at night.
 */
const SUNLIGHT_TOKENS = {
  '--color-bg': '#ffffff',
  '--color-surface': '#f1f2f3',
  '--color-surface-2': '#ffffff',
  '--color-line': '#b9bcc0',
  '--color-ink': '#0b0c0d',
  '--color-muted': '#34383c',
  '--color-dim': '#4a4f54',
} as CSSProperties;

/**
 * The driver screen is light by default whatever the dispatcher's desktop preference, because it
 * is read outdoors. It sets `data-theme` on <html> itself (the tokens hang off that attribute) and
 * restores the previous value on the way out, so the operator app is left as it was found.
 */
function useDriveTheme(): [DriveTheme, () => void] {
  const [theme, setTheme] = useState<DriveTheme>('light');

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_KEY);
    } catch {
      /* private mode: day mode for the session */
    }
    if (stored === 'dark') setTheme('dark');
    const previous = document.documentElement.getAttribute('data-theme');
    return () => {
      if (previous) document.documentElement.setAttribute('data-theme', previous);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignored */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

/** Page frame shared by the pairing and tracking screens: one column, phone width, big type. */
function DriveFrame({
  theme,
  onToggleTheme,
  identifier,
  children,
}: {
  theme: DriveTheme;
  onToggleTheme: () => void;
  identifier?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  return (
    <main
      className="min-h-screen bg-[var(--color-bg)] text-[16px] text-[var(--color-ink)]"
      style={theme === 'light' ? SUNLIGHT_TOKENS : undefined}
    >
      <div className="mx-auto flex min-h-screen max-w-md flex-col gap-5 px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between gap-3">
          <span className="pop flex items-center gap-2.5">
            <Logo size={28} />
            <span className="text-[17px] font-semibold tracking-[0.06em]">SCIP</span>
            <span className="text-[16px] text-[var(--color-muted)]">· {t('drive.title')}</span>
          </span>
          <span className="flex items-center gap-2">
            {identifier && <span className="t-data truncate text-[16px] text-[var(--color-muted)]">{identifier}</span>}
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? t('drive.v3.dayMode') : t('drive.v3.nightMode')}
              title={theme === 'dark' ? t('drive.v3.dayMode') : t('drive.v3.nightMode')}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)]"
            >
              <ThemeIcon className="h-5 w-5" />
            </button>
          </span>
        </header>
        {children}
      </div>
    </main>
  );
}

interface Stats {
  taken: number;
  queued: number;
  sent: number;
  rejected: number;
  lastSentAt: number | null;
}

export default function DrivePage() {
  const { t, locale } = useI18n();
  const [theme, toggleTheme] = useDriveTheme();

  const [credential, setCredential] = useState<Credential | null>(null);
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [stats, setStats] = useState<Stats>({
    taken: 0,
    queued: 0,
    sent: 0,
    rejected: 0,
    lastSentAt: null,
  });

  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Read inside the flush timer, which is created once; state would be captured stale.
  const credentialRef = useRef<Credential | null>(null);
  const flushingRef = useRef(false);

  useEffect(() => {
    credentialRef.current = credential;
  }, [credential]);

  /* --------------------------------------------------------------- restore */

  useEffect(() => {
    const stored = window.localStorage.getItem(CREDENTIAL_KEY);
    if (stored) {
      try {
        setCredential(JSON.parse(stored) as Credential);
      } catch {
        window.localStorage.removeItem(CREDENTIAL_KEY);
      }
    }
    void count().then((queued) => setStats((s) => ({ ...s, queued })));

    const setOnlineState = () => setOnline(navigator.onLine);
    setOnlineState();
    window.addEventListener('online', setOnlineState);
    window.addEventListener('offline', setOnlineState);
    return () => {
      window.removeEventListener('online', setOnlineState);
      window.removeEventListener('offline', setOnlineState);
    };
  }, []);

  /* ---------------------------------------------------------------- flush */

  const flush = useCallback(async () => {
    // One flush at a time. Two overlapping flushes would read the same head of the queue and
    // send every fix twice.
    if (flushingRef.current || !navigator.onLine) return;
    const active = credentialRef.current;
    if (!active) return;

    flushingRef.current = true;
    try {
      const batch = await peek(BATCH_SIZE);
      if (batch.length === 0) return;

      const response = await fetch(`${apiUrl()}/devices/phone/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: active.identifier,
          secret: active.secret,
          fixes: batch.map(({ id: _id, ...fix }) => fix),
        }),
      });

      if (!response.ok) return; // Keep the queue; try again on the next tick.

      const result = (await response.json()) as {
        accepted: number;
        rejected: number;
        error?: string;
      };

      if (result.error) {
        setError(result.error);
        return;
      }

      // Drop only what the server has answered for. A fix the server *rejected* is still
      // resolved — it will be rejected identically forever, so keeping it would wedge the queue
      // behind a position that can never be accepted.
      await drop(batch.map((fix) => fix.id).filter((id): id is number => id !== undefined));

      const queued = await count();
      setStats((s) => ({
        ...s,
        queued,
        sent: s.sent + result.accepted,
        rejected: s.rejected + result.rejected,
        lastSentAt: Date.now(),
      }));
      setError(null);
    } catch {
      // Network failure mid-request: the queue is untouched and the next tick retries.
    } finally {
      flushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!tracking) return;
    const timer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    void flush();
    return () => window.clearInterval(timer);
  }, [tracking, flush]);

  // Coming back into coverage should not wait out the rest of the interval.
  useEffect(() => {
    if (online && tracking) void flush();
  }, [online, tracking, flush]);

  /* ------------------------------------------------------------- wake lock */

  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      setWakeLockHeld(true);
      sentinel.addEventListener('release', () => setWakeLockHeld(false));
    } catch {
      // Denied, or the tab is not visible. Not fatal — tracking still runs while on screen.
    }
  }, []);

  // The lock is dropped by the browser whenever the page is hidden, so it has to be retaken
  // every time the driver returns to the screen, not only when they press start.
  useEffect(() => {
    if (!tracking) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void acquireWakeLock();
        void flush();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tracking, acquireWakeLock, flush]);

  /* -------------------------------------------------------------- tracking */

  const start = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setError(t('drive.unsupported'));
      return;
    }
    setError(null);

    let battery: number | null = null;
    // Non-standard and Chromium-only. Absent on iOS, which is fine — it is a nicety that lets
    // dispatch see a phone about to die, not something tracking depends on.
    const withBattery = navigator as Navigator & {
      getBattery?: () => Promise<{ level: number }>;
    };
    if (withBattery.getBattery) {
      try {
        battery = Math.round((await withBattery.getBattery()).level * 100);
      } catch {
        /* ignored */
      }
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (fix) => {
        setPosition(fix);
        const record: BufferedFix = {
          latitude: fix.coords.latitude,
          longitude: fix.coords.longitude,
          // The API takes km/h; the browser reports metres per second, and `null` when the
          // device cannot derive speed from consecutive fixes (common when stationary).
          speedKmh: fix.coords.speed == null ? null : Math.round(fix.coords.speed * 3.6 * 10) / 10,
          headingDegrees: fix.coords.heading == null ? null : Math.round(fix.coords.heading),
          accuracyM: Math.round(fix.coords.accuracy),
          batteryPercent: battery,
          recordedAt: new Date(fix.timestamp).toISOString(),
        };
        void enqueue(record)
          .then(() => trim())
          .then(() => count())
          .then((queued) => {
            setStats((s) => ({ ...s, taken: s.taken + 1, queued }));
            // Send the very first fix straight away instead of waiting out the interval. The
            // timer starts when the driver presses Start, which is a second or two *before* the
            // GPS returns anything, so the first tick always found an empty queue and dispatch
            // watched an unchanged map for the next thirty seconds — exactly when they are most
            // likely to be looking.
            if (queued === 1) void flush();
          });
      },
      (failure) => {
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? t('drive.permissionDenied')
            : failure.message,
        );
      },
      {
        // The whole point is metre-level road position; the coarse network fix would put the
        // truck in the wrong district.
        enableHighAccuracy: true,
        // Never hand back a cached fix. A stale position is worse than no position: it shows a
        // moving truck as parked.
        maximumAge: 0,
        timeout: 30_000,
      },
    );

    setTracking(true);
    void acquireWakeLock();
  }, [acquireWakeLock, flush, t]);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;
    setWakeLockHeld(false);
    setTracking(false);
    // Flush what is left rather than stranding it until the next shift.
    void flush();
  }, [flush]);

  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    void wakeLockRef.current?.release();
  }, []);


  /* ------------------------------------------------------------------ pair */

  if (!credential) {
    return (
      <DriveFrame theme={theme} onToggleTheme={toggleTheme}>
        <PairingForm onPaired={setCredential} />
      </DriveFrame>
    );
  }

  const speedKmh =
    position?.coords.speed == null ? null : Math.round(position.coords.speed * 3.6);

  // Provenance of what dispatch sees: live while fixes reach the server, stale while they pile
  // up on the phone, off when the driver has stopped.
  const provenance: { kind: ProvenanceKind; label: string } = !tracking
    ? { kind: 'offline', label: t('drive.stopped') }
    : online
      ? { kind: 'live', label: t('drive.v3.sending') }
      : { kind: 'stale', label: t('drive.v3.buffering', { n: stats.queued }) };

  return (
    <DriveFrame theme={theme} onToggleTheme={toggleTheme} identifier={credential.identifier}>
      {/* The status block is the whole screen at arm's length in daylight. */}
      <section className="panel rise flex flex-col items-center gap-4 px-5 py-7 text-center" aria-live="polite">
        <span className="[&_.prov]:gap-2 [&_.prov]:text-[16px] [&_.prov-dot]:h-3 [&_.prov-dot]:w-3">
          <Provenance kind={provenance.kind} label={provenance.label} />
        </span>

        <div className="flex items-end justify-center gap-2">
          <span className="t-kpi text-[112px] leading-[0.9]">{speedKmh ?? '—'}</span>
          <span className="t-data pb-3 text-[18px] text-[var(--color-muted)]">km/h</span>
        </div>

        {position ? (
          <p className="t-data m-0 text-[16px] text-[var(--color-muted)]">
            {position.coords.latitude.toFixed(5)}, {position.coords.longitude.toFixed(5)} · ±
            {Math.round(position.coords.accuracy)} m
          </p>
        ) : (
          tracking && <p className="m-0 text-[16px] text-[var(--color-muted)]">{t('drive.v3.noFix')}</p>
        )}
      </section>

      <button
        type="button"
        onClick={tracking ? stop : () => void start()}
        // 72 px of height: a gloved thumb in a moving cab, not a mouse pointer.
        className={`btn h-[72px] w-full gap-3 text-[18px] font-semibold [&_svg]:!h-6 [&_svg]:!w-6 ${
          tracking ? 'border-2 !border-[var(--color-ink)]' : 'btn-primary'
        }`}
      >
        {tracking ? <Square fill="currentColor" /> : <Play fill="currentColor" />}
        {tracking ? t('drive.stop') : t('drive.start')}
      </button>

      {error && (
        <div className="[&_b]:text-[16px] [&_span]:!text-[16px]">
          <Banner tone="alert" icon={TriangleAlert} title={error} />
        </div>
      )}

      {!online && (
        <div className="[&_b]:text-[16px] [&_span]:!text-[16px]">
          <Banner tone="warn" icon={WifiOff} title={t('drive.offline')}>
            {t('drive.v3.buffering', { n: stats.queued })}
          </Banner>
        </div>
      )}

      <dl className="stagger m-0 grid grid-cols-2 gap-3">
        <Stat label={t('drive.fixes')} value={stats.taken} />
        <Stat label={t('drive.queued')} value={stats.queued} warn={stats.queued > 50} />
        <Stat label={t('drive.sent')} value={stats.sent} />
        <Stat
          label={t('drive.lastSent')}
          value={
            stats.lastSentAt
              ? new Date(stats.lastSentAt).toLocaleTimeString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : t('drive.never')
          }
        />
      </dl>

      {stats.rejected > 0 && (
        <p className="t-data m-0 text-[16px] text-[var(--color-muted)]">
          {t('drive.rejectedHint', { n: stats.rejected })}
        </p>
      )}

      {tracking && (
        <p className="m-0 flex gap-3 text-[16px] leading-relaxed text-[var(--color-muted)]">
          <TriangleAlert className="mt-1 h-5 w-5 shrink-0 text-[var(--color-warn)]" />
          <span>
            {t('drive.screenWarning')}
            {wakeLockHeld && ` · ${t('drive.wakeLockOn')}`}
          </span>
        </p>
      )}

      <p className="m-0 flex gap-3 text-[16px] leading-relaxed text-[var(--color-muted)]">
        <BatteryCharging className="mt-1 h-5 w-5 shrink-0" />
        <span>{t('drive.batteryHint')}</span>
      </p>

      <button
        type="button"
        onClick={() => {
          stop();
          void clear();
          window.localStorage.removeItem(CREDENTIAL_KEY);
          setCredential(null);
          setStats({ taken: 0, queued: 0, sent: 0, rejected: 0, lastSentAt: null });
        }}
        className="mt-auto min-h-12 text-[16px] text-[var(--color-muted)] underline underline-offset-4"
      >
        {t('drive.forget')}
      </button>
    </DriveFrame>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="tile flex flex-col gap-1 p-4">
      <dt className="flex items-center gap-1.5 text-[16px] text-[var(--color-muted)]">
        {label}
        {warn && <TriangleAlert className="h-4 w-4 text-[var(--color-warn)]" aria-hidden />}
      </dt>
      <dd className="t-kpi m-0 text-[34px]">{value}</dd>
    </div>
  );
}

function PairingForm({ onPaired }: { onPaired: (credential: Credential) => void }) {
  const { t } = useI18n();
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');

  // A dispatcher can send the whole thing as one link, so the driver types nothing at all.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const key = params.get('key');
    if (id) setIdentifier(id);
    if (key) setSecret(key);
  }, []);

  const inputClass = 'field t-data !h-14 !rounded-[var(--radius-md)] !border-2 !text-[18px]';

  return (
    <div className="stagger flex flex-1 flex-col justify-center gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[32px] font-normal leading-tight">{t('drive.pair')}</h1>
        <p className="m-0 text-[16px] leading-relaxed text-[var(--color-muted)]">{t('drive.pairIntro')}</p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const credential = { identifier: identifier.trim(), secret: secret.trim() };
          if (!credential.identifier || !credential.secret) return;
          window.localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential));
          onPaired(credential);
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="text-[16px] font-medium">{t('drive.identifier')}</span>
          <input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-[16px] font-medium">{t('drive.secret')}</span>
          <input
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>

        <button
          type="submit"
          disabled={!identifier.trim() || !secret.trim()}
          className="btn btn-primary mt-2 h-[72px] w-full gap-3 text-[18px] [&_svg]:!h-6 [&_svg]:!w-6"
        >
          <Play fill="currentColor" />
          {t('drive.start')}
        </button>
      </form>

      <p className="m-0 text-[16px] leading-relaxed text-[var(--color-muted)]">{t('drive.install')}</p>
    </div>
  );
}
