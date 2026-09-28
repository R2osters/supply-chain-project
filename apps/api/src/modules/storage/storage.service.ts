import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config/configuration';
import { isValidStorageKey, signStorageKey } from './signed-url';

export interface StoredFile {
  body: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Local file storage for proof-of-delivery photos and signatures.
 *
 * SCIP runs as a single-machine desktop app, so files live in the data directory next to the
 * database instead of in an object store. The contract is unchanged from the S3 version: files
 * never go in the database (a photo can be several megabytes and would bloat every backup), the
 * database holds a key, and readers receive a short-lived signed link rather than the raw path.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;
  private readonly signingSecret: string;
  private readonly publicBaseUrl: string;
  private available = false;

  constructor(config: ConfigService<AppConfig, true>) {
    const storage = config.get('storage', { infer: true });
    this.root = resolve(storage.dir);
    this.signingSecret = storage.signingSecret;
    this.publicBaseUrl = storage.publicBaseUrl.replace(/\/$/, '');
  }

  /** Creates the directory on boot so a fresh install just works. */
  async onModuleInit(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      this.available = true;
    } catch (error) {
      // A read-only or missing data directory must not stop the API booting: everything except
      // proof-of-delivery capture keeps working.
      this.available = false;
      this.logger.warn(
        `File storage unavailable at ${this.root} (${error instanceof Error ? error.message : error}). ` +
          'Proof-of-delivery uploads will be rejected.',
      );
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Stores a base64 payload and returns its key.
   * Keys are namespaced by company and delivery so a listing is scoped and a stray key from one
   * tenant cannot be guessed from another's.
   */
  async putBase64(
    companyId: string,
    deliveryId: string,
    kind: 'signature' | 'photo',
    base64: string,
    contentType = 'image/png',
  ): Promise<string> {
    if (!this.available) {
      throw new Error('File storage is unavailable; the file was not stored');
    }

    const payload = base64.includes(',') ? base64.split(',')[1] : base64;
    const body = Buffer.from(payload, 'base64');

    if (body.length === 0) throw new Error('The uploaded file is empty');
    if (body.length > 10 * 1024 * 1024) {
      throw new Error('File exceeds the 10 MB limit for proof of delivery');
    }

    const extension = contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const key = `${companyId}/${deliveryId}/${kind}-${randomUUID()}.${extension}`;
    const path = this.pathFor(key);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { flag: 'wx' });
    return key;
  }

  /** Reads a stored file. Callers must have verified a signed link first. */
  async read(key: string): Promise<StoredFile> {
    const body = await readFile(this.pathFor(key));
    const extension = key.slice(key.lastIndexOf('.') + 1);
    return { body, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
  }

  /** Time-limited download link. 15 minutes is long enough to click, short enough to not leak. */
  async presignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = signStorageKey(this.signingSecret, key, expires);
    const query = new URLSearchParams({ key, expires: String(expires), signature });
    return `${this.publicBaseUrl}/files?${query.toString()}`;
  }

  async presignMany(keys: string[]): Promise<Array<{ key: string; url: string }>> {
    return Promise.all(
      keys.map(async (key) => ({ key, url: await this.presignedUrl(key) })),
    );
  }

  /**
   * Maps a key to a path inside the storage root. The key pattern already excludes `..`, but the
   * containment check stays: it is the one line that stops a path-traversal bug elsewhere from
   * turning into reading arbitrary files off the user's disk.
   */
  private pathFor(key: string): string {
    if (!isValidStorageKey(key)) throw new Error('Invalid storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
}
