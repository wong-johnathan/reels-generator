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
 * pulls `linux/amd64` images that CI published, only `web` is reachable from the
 * host, data lives in named volumes, and every service validates its
 * environment at startup (R-016-1…R-016-5).
 *
 * Application images track `:latest` with `pull_policy: always` — the operator
 * traded R-016-1's digest pinning for a single mutable tag (DEVIATIONS.md D-E).
 * These assertions encode that decision so it cannot drift back: no digest, no
 * release variable, and a pull on every deploy.
 *
 * These are structural assertions on the checked-in files. A green run here does
 * not replace a real `compose up` on the NAS; docs/DEPLOYMENT.md §6 records that
 * manual check.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Service {
  readonly image?: string;
  readonly platform?: string;
  readonly pull_policy?: string;
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
  readonly env?: Readonly<Record<string, string>>;
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

const composeText = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const compose = parse(composeText, { merge: true }) as ComposeFile;
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8')) as Workflow;

const ALWAYS_ON = ['web', 'content-worker', 'render-worker', 'postgres', 'redis', 'minio'];
const ONE_SHOT = ['migrate', 'backup'];
const APP_SERVICES = ['web', 'content-worker', 'render-worker', 'migrate', 'backup'];
const LATEST = /^\$\{DOCKERHUB_USER:-[a-z0-9]+\}\/reels-generator-[a-z]+:latest$/;
const RELEASE_VARIABLES = [
  'RELEASE_TAG',
  'WEB_DIGEST',
  'WORKER_DIGEST',
  'OPS_DIGEST',
  'MINIO_IMAGE',
];

describe('compose.yaml (R-016 deployment contract)', () => {
  it('declares the six always-on services and the two profile-gated one-shots', () => {
    expect(Object.keys(compose.services).sort()).toEqual([...ALWAYS_ON, ...ONE_SHOT].sort());
    for (const name of ONE_SHOT) {
      expect(compose.services[name]?.profiles, `${name} profile`).toHaveLength(1);
    }
    for (const name of ALWAYS_ON) {
      expect(compose.services[name]?.profiles, `${name} must be always-on`).toBeUndefined();
    }
  });

  it('never builds on the NAS: no service has a build key (R-016-2)', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.build, `${name} must not build`).toBeUndefined();
    }
  });

  it('runs every service as linux/amd64 (DS923+ is x86_64)', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.platform, `${name} platform`).toBe('linux/amd64');
    }
  });

  it('tracks :latest for application images and re-pulls on every deploy', () => {
    const prefix = workflow.env?.['DOCKERHUB_PREFIX'];
    expect(prefix, 'workflow env DOCKERHUB_PREFIX').toBeTruthy();
    const [org, repo] = String(prefix).split('/');
    // Which published repository each service consumes.
    const published: Readonly<Record<string, string>> = {
      web: `${repo}-web`,
      'content-worker': `${repo}-worker`,
      'render-worker': `${repo}-worker`,
      migrate: `${repo}-worker`,
      backup: `${repo}-ops`,
    };

    for (const name of APP_SERVICES) {
      const service = compose.services[name];
      expect(service?.image, name).toBe(`\${DOCKERHUB_USER:-${org}}/${published[name]}:latest`);
      expect(service?.image, name).toMatch(LATEST);
      // Without this, `:latest` means "whatever is already cached locally".
      expect(service?.pull_policy, `${name} must re-pull`).toBe('always');
    }
  });

  it('carries no digest and no release variable anywhere', () => {
    // The operator chose one mutable tag over reproducible pins (D-E). A digest
    // creeping back in would silently reinstate a second deploy model.
    expect(composeText).not.toContain('@sha256:');
    for (const key of RELEASE_VARIABLES) {
      expect(composeText, key).not.toContain(key);
    }
    expect(composeText, 'no required interpolation for image refs').not.toMatch(
      /image: \$\{[A-Z0-9_]+:\?/,
    );
  });

  it('ships the object store with a concrete reference', () => {
    const image = compose.services.minio?.image ?? '';
    expect(image).toMatch(/^[a-z0-9.-]+\/minio\/minio:RELEASE\.[0-9TZ.-]+$/);
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
    for (const name of ONE_SHOT) {
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
    expect(compose.services.backup?.image).toContain('reels-generator-ops');
  });
});

describe('tracked environment files (R-015-5, R-016-5)', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  const tracked = gitignore.filter((line) => line.startsWith('!.')).map((line) => line.slice(1));

  it('ignores the real environment file but tracks both templates', () => {
    expect(gitignore).toContain('.env');
    expect(tracked).toEqual(expect.arrayContaining(['.env.example', '.env.template']));
    for (const name of tracked) {
      expect(existsSync(join(ROOT, name)), name).toBe(true);
    }
  });

  it('.env.example lists every validator key, names only (no values)', () => {
    const template = readFileSync(join(ROOT, '.env.example'), 'utf8');
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

  it('neither template mentions a release tag or digest', () => {
    for (const name of tracked) {
      const text = readFileSync(join(ROOT, name), 'utf8');
      for (const key of RELEASE_VARIABLES) {
        expect(text, `${name} still mentions ${key}`).not.toContain(key);
      }
    }
  });

  it('both carry the Docker Hub organisation the images are published under', () => {
    for (const name of tracked) {
      expect(readFileSync(join(ROOT, name), 'utf8'), name).toContain('DOCKERHUB_USER');
    }
  });
});

describe('.github/workflows/build.yml (R-016-1/2)', () => {
  it('builds all three images for linux/amd64 and pushes them', () => {
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

  it('publishes to Docker Hub as well as GHCR, since compose pulls Docker Hub', () => {
    const steps = workflow.jobs.images?.steps ?? [];
    const registries = steps
      .filter((step) => step.uses?.startsWith('docker/login-action'))
      .map((step) => step.with?.['registry']);
    expect(registries).toEqual(expect.arrayContaining(['docker.io', 'ghcr.io']));

    const build = steps.find((step) => step.uses === 'docker/build-push-action@v6');
    const tags = String(build?.with?.['tags'] ?? '');
    expect(tags).toContain('DOCKERHUB_PREFIX');
    expect(tags, 'main pushes move :latest').toContain('latest');
  });

  it('no longer produces an images.env release manifest', () => {
    // Nothing pins by digest any more; a leftover manifest would be a second,
    // misleading deploy model.
    expect(workflow.jobs['release-manifest']).toBeUndefined();
    expect(JSON.stringify(workflow.jobs)).not.toContain('images.env');
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

  it('documents pull, migrate, start, upgrade, rollback and the data-loss warning', () => {
    expect(guide).toContain('--profile migrate');
    expect(guide).toContain('deploy/up.sh');
    expect(guide).toContain('down -v');
    expect(guide.toLowerCase()).toContain('rollback');
    expect(guide).toContain('linux/amd64');
    expect(guide).toContain('docker compose pull');
  });
});
