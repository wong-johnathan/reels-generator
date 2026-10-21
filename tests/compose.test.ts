import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENV_KEYS } from '../src/config/env.js';

/**
 * R-016 deployment contract.
 *
 * The NAS never builds and never installs application dependencies: compose
 * pulls digest-pinned amd64 images that CI published, only `web` is reachable
 * from the host, data lives in named volumes, and every service validates its
 * environment at startup (R-016-1…R-016-5).
 *
 * These are structural assertions on the checked-in files. A green run here
 * does not replace a real `compose up` on the NAS; docs/DEPLOYMENT.md §6 records
 * that manual check.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Service {
  readonly image?: string;
  readonly platform?: string;
  readonly profiles?: readonly string[];
  readonly build?: unknown;
  readonly ports?: readonly string[];
  readonly restart?: string;
  readonly healthcheck?: { readonly test: readonly string[] };
  readonly entrypoint?: readonly string[];
  readonly command?: readonly string[];
  readonly networks?: readonly string[];
  readonly volumes?: readonly string[];
}

interface ComposeFile {
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
  readonly networks?: Readonly<Record<string, unknown>>;
}

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly steps?: readonly Step[];
        readonly strategy?: {
          readonly matrix?: { readonly include?: readonly Record<string, string>[] };
        };
      }
    >
  >;
}

const compose = parse(readFileSync(join(ROOT, 'compose.yaml'), 'utf8'), {
  merge: true,
}) as ComposeFile;
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8')) as Workflow;

const ALWAYS_ON = ['web', 'content-worker', 'render-worker', 'postgres', 'redis', 'minio'];
const PINNED = /@sha256:[a-f0-9]{64}$/;

describe('compose.yaml (R-016-1/2/3/4)', () => {
  it('declares the six always-on services and the two profile-gated one-shots', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      [...ALWAYS_ON, 'migrate', 'backup'].sort(),
    );
  });

  it('never builds on the NAS: no service has a build key (R-016-2)', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service, `${name} must pull a prebuilt image`).not.toHaveProperty('build');
    }
  });

  it('pins every image by tag and digest, for linux/amd64 (R-016-1)', () => {
    for (const name of ALWAYS_ON) {
      const service = compose.services[name];
      expect(service, name).toBeDefined();
      expect(service?.platform, `${name} platform`).toBe('linux/amd64');
      const image = service?.image ?? '';
      if (name === 'minio') {
        // `minio/minio` is gone from Docker Hub and quay.io needs registry auth,
        // so the object-store image is an operator-supplied, digest-pinned ref.
        expect(image, 'minio must require an operator-pinned image').toContain(':?');
        expect(image, 'minio image variable').toContain('MINIO_IMAGE');
      } else if (name === 'postgres' || name === 'redis') {
        // Third-party stores are pinned by a fixed upstream tag + digest, not by
        // the app release tag. Exact pinning is asserted below (PINNED).
        expect(image, `${name} must be digest-pinned`).toContain('@sha256:');
        expect(image, `${name} must be digest-pinned`).toMatch(PINNED);
      } else {
        expect(image, `${name} must be digest-pinned`).toContain('@sha256:');
        expect(image, `${name} must carry a release tag`).toContain('${RELEASE_TAG');
      }
    }
    expect(compose.services.postgres?.image).toMatch(PINNED);
    expect(compose.services.redis?.image).toMatch(PINNED);
  });

  it('publishes only the web entrypoint; stores stay on the private network (R-016-3)', () => {
    const published = Object.entries(compose.services)
      .filter(([, service]) => (service.ports ?? []).length > 0)
      .map(([name]) => name);
    expect(published).toEqual(['web']);
    expect(compose.services.web?.ports).toEqual(['8080:8080']);

    for (const name of ALWAYS_ON) {
      expect(compose.services[name]?.networks, `${name} network`).toEqual(['private']);
    }
    const storePorts = ['postgres', 'redis', 'minio'].flatMap(
      (name) => compose.services[name]?.ports ?? [],
    );
    expect(storePorts).toEqual([]);
  });

  it('keeps data on named volumes, so `down` cannot delete it (R-016-4)', () => {
    expect(Object.keys(compose.volumes ?? {}).sort()).toEqual(['miniodata', 'pgdata', 'redisdata']);
    expect(compose.services.postgres?.volumes).toContain('pgdata:/var/lib/postgresql/data');
    expect(compose.services.redis?.volumes).toContain('redisdata:/data');
    expect(compose.services.minio?.volumes).toContain('miniodata:/data');
  });

  it('gives every always-on service a restart policy and a health check', () => {
    for (const name of ALWAYS_ON) {
      expect(compose.services[name]?.restart, `${name} restart`).toBe('unless-stopped');
      expect(
        compose.services[name]?.healthcheck?.test.length,
        `${name} healthcheck`,
      ).toBeGreaterThan(0);
    }
  });

  it('runs the migration one-shot as the migrate role, not as a queue consumer', () => {
    for (const name of ['migrate', 'backup']) {
      expect(compose.services[name]?.profiles, `${name} profile`).toHaveLength(1);
      expect(compose.services[name]?.restart, `${name} restart`).toBe('no');
    }
    expect(compose.services.migrate?.entrypoint).toEqual([
      'node',
      'dist/src/boot/validate-env.js',
      '--role',
      'migrate',
      '--exec',
    ]);
    expect(compose.services.migrate?.command).toEqual(['node', 'dist/src/db/migrate.js']);
    expect(compose.services.backup?.image).toContain('OPS_DIGEST');
  });
});

describe('tracked environment template (R-016-1/5, R-015-5)', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  const templateName = gitignore.find((line) => line.startsWith('!.'))?.slice(1);

  it('ignores the real environment file but tracks the names-only template', () => {
    expect(gitignore).toContain('.env');
    expect(templateName).toBeDefined();
    expect(existsSync(join(ROOT, templateName ?? ''))).toBe(true);
  });

  it('lists every key the validator knows, with no values (names only)', () => {
    const template = readFileSync(join(ROOT, templateName ?? ''), 'utf8');
    const assignments = template
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));

    const keys = assignments.map((line) => line.slice(0, line.indexOf('=')));
    expect(new Set(keys).size, 'duplicate key').toBe(keys.length);
    for (const key of ENV_KEYS) expect(keys, `missing ${key}`).toContain(key);
    for (const line of assignments) {
      expect(line.slice(line.indexOf('=') + 1), `${line} must not ship a value`).toBe('');
    }
  });

  it('carries the release pins compose requires', () => {
    const template = readFileSync(join(ROOT, templateName ?? ''), 'utf8');
    for (const key of ['RELEASE_TAG', 'WEB_DIGEST', 'WORKER_DIGEST', 'OPS_DIGEST', 'MINIO_IMAGE']) {
      expect(template, `missing ${key}`).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});

describe('.github/workflows/build.yml (R-016-1/2)', () => {
  it('builds all three images for linux/amd64 and pushes them to GHCR', () => {
    const include = workflow.jobs.images?.strategy?.matrix?.include ?? [];
    expect(include.map((entry) => entry.dockerfile)).toEqual([
      'Dockerfile.web',
      'Dockerfile.worker',
      'Dockerfile.ops',
    ]);

    const build = workflow.jobs.images?.steps?.find(
      (step) => step.uses === 'docker/build-push-action@v6',
    );
    expect(build?.with?.['platforms']).toBe('linux/amd64');
    expect(build?.with?.['push']).toBe(true);
    expect(workflow.permissions?.['packages']).toBe('write');
  });

  it('publishes the tag plus the three digests the NAS pins', () => {
    const manifest = workflow.jobs['release-manifest']?.steps?.find(
      (step) => typeof step.run === 'string' && step.run.includes('WEB_DIGEST'),
    );
    expect(manifest).toBeDefined();
    for (const key of ['RELEASE_TAG', 'WEB_DIGEST', 'WORKER_DIGEST', 'OPS_DIGEST']) {
      expect(manifest?.run).toContain(key);
    }
  });

  it('writes the digest in the form compose interpolates after @sha256: (R-016-1/2)', () => {
    // docker/build-push-action outputs `digest` as `sha256:<64 hex>`, while
    // compose.yaml pins `@sha256:${WEB_DIGEST}`. If CI kept the prefix, every
    // image ref would become `@sha256:sha256:<hex>` and the NAS pull would fail.
    // images.env must therefore carry the bare 64-hex digest.
    const manifest = workflow.jobs['release-manifest']?.steps?.find(
      (step) => typeof step.run === 'string' && step.run.includes('WEB_DIGEST'),
    );
    const run = manifest?.run ?? '';
    for (const key of ['WEB_DIGEST', 'WORKER_DIGEST', 'OPS_DIGEST']) {
      expect(run, `${key} must be stripped of the sha256: prefix`).toContain(
        `${key}="\${${key}#sha256:}"`,
      );
    }
    expect(run, 'a malformed pin must fail the release job').toContain('[0-9a-f]{64}');
    expect(run, 'compose keeps the sha256: prefix').not.toMatch(
      /@\$\{?RELEASE_TAG.*@\$\{WEB_DIGEST/,
    );
  });

  it('fails CI if the real environment file ever enters history (R-015-5)', () => {
    const guard = workflow.jobs['verify']?.steps?.find((step) =>
      step.name?.toLowerCase().includes('history'),
    );
    expect(guard?.run).toContain('git log --all');
  });
});

describe('deployment guide (R-016-1/2/4)', () => {
  const guide = readFileSync(join(ROOT, 'docs/DEPLOYMENT.md'), 'utf8');

  it('documents migrate, start, upgrade, rollback and the data-loss warning', () => {
    expect(guide).toContain('--profile migrate');
    expect(guide).toContain('deploy/up.sh');
    expect(guide).toContain('down -v');
    expect(guide.toLowerCase()).toContain('rollback');
    expect(guide).toContain('linux/amd64');
  });
});
