import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';

/**
 * S3-compatible object storage for proof-of-delivery photos and signatures.
 *
 * Files never go in the database. A signature PNG is 20–80 KB and a delivery photo can be
 * several megabytes; storing them as bytea would bloat every backup, break replication lag and
 * make a simple `SELECT *` a disaster. The database holds the object key, and the key is what
 * travels through the API.
 *
 * Downloads are served as **presigned URLs with a short expiry**, not proxied through the API.
 * Proxying would put every megabyte through the Node event loop; presigning hands the client a
 * time-limited capability and gets out of the way — while keeping the bucket itself private.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private available = false;

  constructor(config: ConfigService<AppConfig, true>) {
    const s3 = config.get('s3', { infer: true });
    this.bucket = s3.bucket;
    this.client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
    });
  }

  /** Creates the bucket on boot if it is missing, so a fresh environment just works. */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.available = true;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.available = true;
        this.logger.log(`Created object storage bucket "${this.bucket}"`);
      } catch (error) {
        // Object storage being down must not stop the API booting: everything except
        // proof-of-delivery capture keeps working.
        this.available = false;
        this.logger.warn(
          `Object storage unavailable (${error instanceof Error ? error.message : error}). ` +
            'Proof-of-delivery uploads will be rejected until it returns.',
        );
      }
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
      throw new Error('Object storage is unavailable; the file was not stored');
    }

    const payload = base64.includes(',') ? base64.split(',')[1] : base64;
    const body = Buffer.from(payload, 'base64');

    if (body.length === 0) throw new Error('The uploaded file is empty');
    if (body.length > 10 * 1024 * 1024) {
      throw new Error('File exceeds the 10 MB limit for proof of delivery');
    }

    const extension = contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const key = `${companyId}/${deliveryId}/${kind}-${randomUUID()}.${extension}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Private by default; access is granted per request through a presigned URL.
        ACL: undefined,
      }),
    );

    return key;
  }

  /** Time-limited download link. 15 minutes is long enough to click, short enough to not leak. */
  async presignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignMany(keys: string[]): Promise<Array<{ key: string; url: string }>> {
    return Promise.all(
      keys.map(async (key) => ({ key, url: await this.presignedUrl(key) })),
    );
  }
}
