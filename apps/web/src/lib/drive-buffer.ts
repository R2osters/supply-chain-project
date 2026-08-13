'use client';

/**
 * The offline queue for the driver's phone.
 *
 * This is the piece that makes phone tracking usable on a real route rather than a demo. The
 * Accra–Kumasi road loses cellular coverage for tens of kilometres at a stretch; a tracker that
 * only reports when it has signal produces a track with a hole in exactly the section a dispatcher
 * would most want to see. The GPS receiver does not care about coverage — it hears satellites, not
 * towers — so positions keep arriving throughout. They are written here and flushed when the
 * network returns.
 *
 * IndexedDB rather than `localStorage` for two reasons that both bite in practice:
 *
 *  1. `localStorage` is synchronous and blocks the main thread. A write on every fix, on a cheap
 *     Android phone, competes with the rendering of the very screen the driver is watching.
 *  2. `localStorage` caps at around 5 MB and, more importantly, throws `QuotaExceededError` when
 *     full. A day of fixes at 10 s intervals is 8 640 records. IndexedDB holds that comfortably.
 *
 * No wrapper library: the surface used here is four operations, and shipping a dependency to a
 * driver on a metered connection to save thirty lines is the wrong trade.
 */

const DB_NAME = 'scip-drive';
const DB_VERSION = 1;
const STORE = 'fixes';

/**
 * Hard ceiling on the queue. Twelve hours at a 10-second interval is ~4 300 fixes; 20 000 leaves
 * generous room for a long shift with no coverage at all, while bounding the damage if a phone is
 * left running for days. When it overflows the *oldest* fixes are dropped, because the recent ones
 * answer "where is the truck now", which is the question being asked.
 */
const MAX_QUEUED = 20_000;

export interface BufferedFix {
  /** Auto-incremented by IndexedDB; the send order and the delete key. */
  id?: number;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  accuracyM: number | null;
  batteryPercent: number | null;
  recordedAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
  });
  return dbPromise;
}

/** Wraps a transaction so the promise settles on the *transaction*, not the request. */
function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return openDatabase().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        let value: T | undefined;
        if (request) request.onsuccess = () => (value = request.result);
        // Resolving on `oncomplete` rather than on the request means a write is only reported as
        // stored once it is actually durable. Reporting earlier would let the app delete a fix it
        // had not really saved.
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

export async function enqueue(fix: BufferedFix): Promise<void> {
  await transact('readwrite', (store) => store.add(fix));
}

/** The oldest `limit` fixes, in the order they were recorded. */
export async function peek(limit: number): Promise<BufferedFix[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll(undefined, limit);
    request.onsuccess = () => resolve(request.result as BufferedFix[]);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'));
  });
}

/**
 * Removes fixes by id. Called only after the server has confirmed the batch, so a request that
 * fails mid-flight leaves the queue intact and the fixes are simply sent again. Duplicates on the
 * server are cheaper than a hole in the track.
 */
export async function drop(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
  });
}

export async function count(): Promise<number> {
  return (await transact<number>('readonly', (store) => store.count())) ?? 0;
}

/** Drops the oldest fixes once the queue exceeds its ceiling. Returns how many were discarded. */
export async function trim(): Promise<number> {
  const total = await count();
  const excess = total - MAX_QUEUED;
  if (excess <= 0) return 0;

  const oldest = await peek(excess);
  await drop(oldest.map((fix) => fix.id).filter((id): id is number => id !== undefined));
  return oldest.length;
}

export async function clear(): Promise<void> {
  await transact('readwrite', (store) => store.clear());
}
