/**
 * S3/MinIO store over a local `node:http` stub — no network dependency.
 *
 * The stub is a stateful, path-style S3: it records every request's
 * method/path/headers/body and answers the handful of operations the store
 * uses (HeadBucket, CreateBucket, HeadObject, PutObject, GetObject) with
 * canned responses, including the 404 XML that maps to `null`/`false`. The
 * assertions prove path-style URLs (`/bucket/key`), readable-key passthrough,
 * and that a 404 never throws.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureBucket } from './object-store.js';
import {
  createS3Client,
  createS3Stores,
  MINIO_DEFAULT_REGION,
  S3BucketStore,
  S3ContentAddressedStore,
  S3StoreConfigError,
  s3ConfigFromEnv,
  type S3StoreConfig,
} from './s3-store.js';

const BUCKET = 'reels-generator';
const BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x7f]);
const KEY = 'series/batch-0001/video.mp4';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

class FakeS3 {
  readonly buckets = new Set<string>();
  readonly objects = new Map<string, StoredObject>();
  readonly requests: RecordedRequest[] = [];
  private readonly server = createServer((req, res) => this.handle(req, res));
  private address: string | null = null;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    this.address = `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.buckets.clear();
    this.objects.clear();
    this.requests.length = 0;
  }

  baseUrl(): string {
    if (this.address === null) throw new Error('FakeS3 not started');
    return this.address;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      this.requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: { ...req.headers },
        body,
      });

      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const segments = path
        .split('/')
        .filter((segment) => segment.length > 0)
        .map(decodeURIComponent);
      const method = req.method ?? 'GET';

      if (segments.length === 1) {
        const bucket = segments[0] as string;
        if (method === 'PUT') {
          this.buckets.add(bucket);
          res.writeHead(200, { 'content-length': '0', location: '/' + bucket });
          res.end();
          return;
        }
        if (method === 'HEAD') {
          if (this.buckets.has(bucket)) {
            res.writeHead(200, { 'content-length': '0' });
            res.end();
          } else {
            this.error(res, 404, 'NoSuchBucket', 'Bucket does not exist');
          }
          return;
        }
        this.error(res, 405, 'MethodNotAllowed');
        return;
      }

      if (segments.length >= 2) {
        const key = segments.slice(1).join('/');
        if (method === 'PUT') {
          this.objects.set(key, {
            bytes: body,
            contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
          });
          res.writeHead(200, { etag: '"etag"', 'content-length': '0' });
          res.end();
          return;
        }
        if (method === 'HEAD') {
          const object = this.objects.get(key);
          if (object !== undefined) {
            res.writeHead(200, {
              'content-type': object.contentType,
              'content-length': String(object.bytes.length),
            });
            res.end();
          } else {
            this.error(res, 404, 'NoSuchKey', 'The specified key does not exist');
          }
          return;
        }
        if (method === 'GET') {
          const object = this.objects.get(key);
          if (object !== undefined) {
            res.writeHead(200, {
              'content-type': object.contentType,
              'content-length': String(object.bytes.length),
            });
            res.end(object.bytes);
          } else {
            this.error(res, 404, 'NoSuchKey', 'The specified key does not exist');
          }
          return;
        }
        this.error(res, 405, 'MethodNotAllowed');
        return;
      }

      this.error(res, 400, 'BadRequest');
    });
  }

  private error(res: ServerResponse, status: number, code: string, message?: string): void {
    const body = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Error><Code>' +
        code +
        '</Code>' +
        (message === undefined ? '' : '<Message>' + message + '</Message>') +
        '</Error>',
    );
    res.writeHead(status, {
      'content-type': 'application/xml',
      'content-length': String(body.length),
    });
    res.end(body);
  }
}

const fake = new FakeS3();
let config: S3StoreConfig;

beforeAll(async () => {
  await fake.start();
  config = {
    endpoint: fake.baseUrl(),
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    bucket: BUCKET,
  };
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  fake.buckets.add(BUCKET);
});

function store(): S3ContentAddressedStore {
  return new S3ContentAddressedStore(createS3Client(config), BUCKET);
}

describe('s3ConfigFromEnv', () => {
  it('names every missing key before any client is built', () => {
    expect(() => s3ConfigFromEnv({})).toThrow(S3StoreConfigError);
    try {
      s3ConfigFromEnv({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(S3StoreConfigError);
      expect((error as S3StoreConfigError).missingKeys).toEqual([
        'MINIO_ENDPOINT',
        'MINIO_ROOT_USER',
        'MINIO_ROOT_PASSWORD',
        'MINIO_BUCKET',
      ]);
    }
  });

  it('reads a complete environment', () => {
    const read = s3ConfigFromEnv({
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ROOT_USER: 'user',
      MINIO_ROOT_PASSWORD: 'password',
      MINIO_BUCKET: 'reels-generator',
    });
    expect(read).toEqual({
      endpoint: 'http://minio:9000',
      accessKeyId: 'user',
      secretAccessKey: 'password',
      bucket: 'reels-generator',
    });
  });
});

describe('S3ContentAddressedStore.put', () => {
  it('PUTs the bytes under the path-style key with the mime type', async () => {
    const result = await store().put(KEY, BYTES, 'image/png');
    expect(result).toEqual({ created: true });

    const put = fake.requests.find((request) => request.method === 'PUT');
    expect(put).toBeDefined();
    // Path-style: the bucket is the first path segment, not a virtual-host
    // prefix. The SDK appends an `x-id=PutObject` disambiguator; decode + strip
    // the query to prove it.
    expect(decodeURIComponent(put!.path.split('?')[0] ?? '')).toBe('/' + BUCKET + '/' + KEY);
    expect(put!.path).toContain('x-id=PutObject');
    expect(put!.headers['content-type']).toBe('image/png');
    expect(put!.body).toEqual(Buffer.from(BYTES));
  });

  it('reports the overwrite when the key already exists and PUTs again', async () => {
    const content = store();
    expect(await content.put(KEY, BYTES, 'image/png')).toEqual({ created: true });
    expect(await content.put(KEY, new Uint8Array([9, 9, 9]), 'image/png')).toEqual({
      created: false,
    });
    expect(fake.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
  });
});

describe('S3ContentAddressedStore.get / has', () => {
  it('round-trips the bytes and mime type', async () => {
    const content = store();
    await content.put(KEY, BYTES, 'video/mp4');
    const stored = await content.get(KEY);
    expect(stored).not.toBeNull();
    expect(stored!.bytes).toEqual(BYTES);
    expect(stored!.mimeType).toBe('video/mp4');
    expect(await content.has(KEY)).toBe(true);
  });

  it('maps a 404 to null for get and false for has, never throwing', async () => {
    const content = store();
    const absent = 'series/batch-0001/absent.bin';
    await expect(content.get(absent)).resolves.toBeNull();
    await expect(content.has(absent)).resolves.toBe(false);
    expect(fake.requests.filter((request) => request.method === 'HEAD')).toHaveLength(1);
  });
});

describe('S3BucketStore / ensureBucket', () => {
  it('reports an existing bucket and creates a missing one, path-style', async () => {
    const bucketStore = new S3BucketStore(createS3Client(config));
    await expect(bucketStore.bucketExists(BUCKET)).resolves.toBe(true);
    await expect(bucketStore.bucketExists('absent')).resolves.toBe(false);

    await ensureBucket(bucketStore, 'new-bucket');
    expect(
      fake.requests.find(
        (request) =>
          request.method === 'PUT' && (request.path.split('?')[0] ?? '').startsWith('/new-bucket'),
      ),
    ).toBeDefined();
    await expect(bucketStore.bucketExists('new-bucket')).resolves.toBe(true);
  });
});

describe('createS3Stores', () => {
  it('builds one client behind both facades', async () => {
    const stores = createS3Stores(config);
    expect(stores.bucketName).toBe(BUCKET);
    await stores.content.put(KEY, BYTES, 'video/mp4');
    expect(await stores.content.get(KEY)).not.toBeNull();
    expect(await stores.bucket.bucketExists(BUCKET)).toBe(true);
  });
});

describe('client shape', () => {
  it('forces path-style addressing and a fixed region for MinIO', async () => {
    const client = createS3Client(config);
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe(MINIO_DEFAULT_REGION);
    await client.destroy();
  });
});
