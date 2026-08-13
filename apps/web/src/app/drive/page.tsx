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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { clear, count, drop, enqueue, peek, trim, type BufferedFix } from '@/lib/drive-buffer';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';
const CREDENTIAL_KEY = 'scip.drive.credential';

/** How often to flush. Short enough that the map is current, long enough to batch a few fixes. */
const FLUSH_INTERVAL_MS = 30_000;

/** The server accepts 500 per request; staying well under keeps a flush quick on a weak signal. */
const BATCH_SIZE = 200;

interface Credential {
  identifier: string;
  secret: string;
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

      const response = await fetch(`${API_URL}/devices/phone/positions`, {
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
    return <PairingForm onPaired={setCredential} />;
  }

  const speedKmh =
    position?.coords.speed == null ? null : Math.round(position.coords.speed * 3.6);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5">
      <header className="flex items-baseline justify-between border-b border-hairline pb-3">
        <span className="font-mono text-xs tracking-[0.2em] text-ink-faint uppercase">
          SCIP · {t('drive.title')}
        </span>
        <span className="font-mono text-xs text-ink-faint">{credential.identifier}</span>
      </header>

      {/* The status block is the whole screen at arm's length in daylight. */}
      <section
        className={`border p-6 text-center ${
          tracking ? 'border-ok/40 bg-ok-dim/30' : 'border-hairline bg-panel'
        }`}
      >
        <div className="flex items-center justify-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              tracking ? 'animate-pulse bg-ok' : 'bg-ink-faint'
            }`}
          />
          <span className="text-lg font-semibold tracking-wide">
            {tracking ? t('drive.tracking') : t('drive.stopped')}
          </span>
        </div>

        <div className="mt-5 flex items-end justify-center gap-2 tnum">
          <span className="font-mono text-6xl leading-none font-semibold">
            {speedKmh ?? '—'}
          </span>
          <span className="pb-1 text-sm text-ink-dim">km/h</span>
        </div>

        {position && (
          <p className="mt-3 font-mono text-xs text-ink-faint tnum">
            {position.coords.latitude.toFixed(5)}, {position.coords.longitude.toFixed(5)} · ±
            {Math.round(position.coords.accuracy)} m
          </p>
        )}
      </section>

      <button
        type="button"
        onClick={tracking ? stop : () => void start()}
        // 68 px of height: a gloved thumb in a moving cab, not a mouse pointer.
        className={`h-[68px] w-full text-base font-semibold tracking-wide uppercase transition ${
          tracking
            ? 'border border-alert/50 bg-alert-dim/40 text-alert active:bg-alert-dim/70'
            : 'bg-signal text-void active:bg-signal/80'
        }`}
      >
        {tracking ? t('drive.stop') : t('drive.start')}
      </button>

      {error && (
        <p className="border border-alert/40 bg-alert-dim/30 p-3 text-sm text-alert">{error}</p>
      )}

      {!online && (
        <p className="border border-warn/40 bg-warn-dim/30 p-3 text-sm text-warn">
          {t('drive.offline')}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-px border border-hairline bg-hairline">
        <Stat label={t('drive.fixes')} value={stats.taken} />
        <Stat label={t('drive.queued')} value={stats.queued} tone={stats.queued > 50 ? 'warn' : undefined} />
        <Stat label={t('drive.sent')} value={stats.sent} tone={stats.sent > 0 ? 'ok' : undefined} />
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
        <p className="font-mono text-xs text-ink-faint">
          {t('drive.rejectedHint', { n: stats.rejected })}
        </p>
      )}

      {tracking && (
        <p className="border-l-2 border-warn/50 pl-3 text-xs leading-relaxed text-ink-dim">
          {t('drive.screenWarning')}
          {wakeLockHeld && ` · ${t('drive.wakeLockOn')}`}
        </p>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">{t('drive.batteryHint')}</p>

      <button
        type="button"
        onClick={() => {
          stop();
          void clear();
          window.localStorage.removeItem(CREDENTIAL_KEY);
          setCredential(null);
          setStats({ taken: 0, queued: 0, sent: 0, rejected: 0, lastSentAt: null });
        }}
        className="mt-auto py-3 text-xs text-ink-faint underline underline-offset-4"
      >
        {t('drive.forget')}
      </button>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'warn';
}) {
  const colour = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="bg-panel p-3">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-ink-faint uppercase">{label}</dt>
      <dd className={`mt-1 font-mono text-xl tnum ${colour}`}>{value}</dd>
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

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      <div>
        <p className="font-mono text-xs tracking-[0.2em] text-ink-faint uppercase">
          SCIP · {t('drive.title')}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{t('drive.pair')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">{t('drive.pairIntro')}</p>
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
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-faint uppercase">
            {t('drive.identifier')}
          </span>
          <input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-14 border border-hairline bg-panel px-3 font-mono text-base outline-none focus:border-signal"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-faint uppercase">
            {t('drive.secret')}
          </span>
          <input
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-14 border border-hairline bg-panel px-3 font-mono text-base outline-none focus:border-signal"
          />
        </label>

        <button
          type="submit"
          className="h-[68px] w-full bg-signal text-base font-semibold tracking-wide text-void uppercase active:bg-signal/80"
        >
          {t('drive.start')}
        </button>
      </form>

      <p className="text-xs leading-relaxed text-ink-faint">{t('drive.install')}</p>
    </main>
  );
}
