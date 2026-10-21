/**
 * MinIO / S3-backed object storage — TECH_DESIGN §2.1, the production binding
 * behind the two ports in `storage/object-store.ts` (R-018 bucket ensure,
 * R-026 content-addressed blobs).
 *
 * The in-memory implementations are the deterministic fakes for tests and the
 * local run; this module is what the worker and web processes construct when
 * `MINIO_ENDPOINT` is present. Path-style addressing is forced (`forcePathStyle`)
 * because the target is a self-hosted MinIO on the docker network, where a
 * bucket name is a path segment (`http://minio:9000/<bucket>/<key>`), not a
 * virtual-host prefix.
 *
 * Object keys are readable paths (deviation D-F), so `put()` does not derive or
 * verify the key against the bytes — a re-render may write different bytes under
 * the same path, and the S3 object is simply overwritten. `get()` maps an S3
 * 404 to `null` (the port's "absent" contract) and lets any other error
 * propagate, so a network failure is never mistaken for absence.
 */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  type ContentAddressedStore,
  type ObjectBucketStore,
  type PutResult,
  type StoredObject,
} from './object-store.js';

/** MinIO does not key off the region; a fixed, valid value satisfies the SDK. */
export const MINIO_DEFAULT_REGION = 'us-east-1';

/** The environment keys the S3 binding needs — names only, never values. */
export interface S3StoreConfig {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region?: string;
}

export class S3StoreConfigError extends Error {
  constructor(readonly missingKeys: readonly string[]) {
    super(
      'object storage is not configured: ' +
        (missingKeys.length === 0
          ? 'no S3/MinIO configuration was supplied'
          : 'missing required key(s) ' + missingKeys.join(', ') + ' (see .env.example)') +
        ' — refusing to start with an in-memory store in production',
    );
    this.name = 'S3StoreConfigError';
  }
}

const S3_REQUIRED_KEYS = [
  'MINIO_ENDPOINT',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_BUCKET',
] as const;

/**
 * Read the S3 binding from an environment source. Throws `S3StoreConfigError`
 * naming every missing key before any client is built — a production process
 * must fail loudly, never silently fall back to an in-memory map.
 */
export function s3ConfigFromEnv(env: Readonly<Record<string, string | undefined>>): S3StoreConfig {
  const missing = S3_REQUIRED_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) throw new S3StoreConfigError(missing);

  return {
    endpoint: env.MINIO_ENDPOINT!.trim(),
    accessKeyId: env.MINIO_ROOT_USER!.trim(),
    secretAccessKey: env.MINIO_ROOT_PASSWORD!.trim(),
    bucket: env.MINIO_BUCKET!.trim(),
  };
}

/** An S3 client against a self-hosted MinIO endpoint, path-style (R-018). */
export function createS3Client(config: S3StoreConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? MINIO_DEFAULT_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** True when an S3 error is an object/bucket absence (404), never a real failure. */
function isS3NotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const code = candidate?.$metadata?.httpStatusCode;
  if (code === 404) return true;
  return (
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NoSuchBucket'
  );
}

/** Blobs in an S3/MinIO bucket, addressed by readable path (D-F). */
export class S3ContentAddressedStore implements ContentAddressedStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    const had = await this.has(objectKey);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
    return { created: !had };
  }

  async get(objectKey: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      const body = await response.Body?.transformToByteArray();
      return {
        bytes: body ?? new Uint8Array(0),
        mimeType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }

  async has(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }
}

/** Bucket lifecycle against S3/MinIO — the R-018 boot-time ensure surface. */
export class S3BucketStore implements ObjectBucketStore {
  constructor(private readonly client: S3Client) {}

  async bucketExists(name: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: name }));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }

  async makeBucket(name: string): Promise<void> {
    await this.client.send(new CreateBucketCommand({ Bucket: name }));
  }
}

/** Build the two store facades over one S3 client (worker/web construction). */
export interface S3Stores {
  readonly bucketName: string;
  readonly content: ContentAddressedStore;
  readonly bucket: ObjectBucketStore;
}

export function createS3Stores(config: S3StoreConfig): S3Stores {
  const client = createS3Client(config);
  return {
    bucketName: config.bucket,
    content: new S3ContentAddressedStore(client, config.bucket),
    bucket: new S3BucketStore(client),
  };
}
