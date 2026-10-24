import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gatePath = join(root, 'scripts/run-browser-gate.mjs');
const proofPath = join(root, 'scripts/prove-browser-output.mjs');
// Variable URL imports keep the existing JS runner authoritative without changing TS config.
const { discoverHarnesses, resolveBrowser } = await import(pathToFileURL(gatePath).href);
const harnesses = [
  ['scene-remediation', 'scene'],
  ['batch-detail', 'batch'],
  ['shell-quality', 'shell'],
  ['surface-followup', 'surface'],
];

function temporary() {
  return mkdtempSync(join(tmpdir(), 'browser-contract-'));
}

function outputFrom(source: string, env: Record<string, string | undefined>) {
  const initializers = source.match(/^const output = [^;\n]+;$/gm);
  expect(initializers, 'exactly one bounded single-line output initializer').toHaveLength(1);
  const initializer = initializers![0]!;
  // Fail closed on syntax drift; only evaluate the actual initializer, never the harness.
  expect(initializer).toMatch(
    /^const output = (?:join\(resolve\(process\.env\.BROWSER_OUTPUT_DIR \|\| '[^']+'\), '[^']+'\)|resolve\(process\.env\.BROWSER_OUTPUT_DIR \|\| '[^']+', '[^']+'\));$/,
  );
  return runInNewContext(`${initializer}\noutput`, { process: { env }, resolve, join });
}

describe('C-RET-1 actual browser output initializers', () => {
  for (const [label, value] of [
    ['unset', undefined],
    ['empty', ''],
    ['absolute', resolve(tmpdir(), 'external-contract-output')],
    ['relative', 'relative-contract-output'],
  ]) {
    it(`resolves all four unique namespaces from project cwd (${label})`, () => {
      expect(process.cwd()).toBe(root.replace(/\/$/, ''));
      const outputs = harnesses.map(([name, namespace]) => {
        const source = readFileSync(join(root, `tests/web/${name}.browser.mjs`), 'utf8');
        const env = value === undefined ? {} : { BROWSER_OUTPUT_DIR: value };
        const actual = outputFrom(source, env);
        expect(actual).toBe(resolve(root, value || 'evidence/.browser-run', namespace!));
        return actual;
      });
      expect(new Set(outputs).size).toBe(4);
    });
  }

  it('fails clearly rather than silently accepting initializer syntax drift', () => {
    expect(() => outputFrom('const output = helper();', {})).toThrow();
    expect(() => outputFrom('const renamed = "elsewhere";', {})).toThrow();
  });
});

it('C-RET-2 Git and installed Prettier ignore nested JSON/PNG, not a control', async () => {
  const { getFileInfo } = await import('prettier');
  mkdirSync(join(root, 'evidence/.browser-run'), { recursive: true });
  const nested = mkdtempSync(join(root, 'evidence/.browser-run/contract-'));
  const control = mkdtempSync(join(root, 'evidence/contract-control-'));
  try {
    const paths = [join(nested, 'deep/results.json'), join(nested, 'deep/screenshot.png')];
    mkdirSync(join(nested, 'deep'));
    paths.forEach((path) => writeFileSync(path, 'unique disposable fixture'));
    const controlPath = join(control, 'results.json');
    writeFileSync(controlPath, '{}');
    for (const path of paths) {
      expect(spawnSync('git', ['check-ignore', '--quiet', path], { cwd: root }).status).toBe(0);
      expect((await getFileInfo(path, { ignorePath: join(root, '.prettierignore') })).ignored).toBe(
        true,
      );
    }
    expect(spawnSync('git', ['check-ignore', '--quiet', controlPath], { cwd: root }).status).toBe(
      1,
    );
    expect(
      (await getFileInfo(controlPath, { ignorePath: join(root, '.prettierignore') })).ignored,
    ).toBe(false);
  } finally {
    rmSync(nested, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

describe('C-RET-4 existing gate discovery and tool failures (no browser installation)', () => {
  it('discovers actual four only; proof driver is not a browser harness', () => {
    expect(discoverHarnesses().map((path: string) => basename(path))).toEqual(
      harnesses.map(([name]) => `${name}.browser.mjs`),
    );
  });

  it('retains preferred order, sorted extras, present-only and empty failure', () => {
    const fixture = temporary();
    try {
      const web = join(fixture, 'tests/web');
      mkdirSync(web, { recursive: true });
      expect(() => discoverHarnesses(fixture)).toThrow('No browser harnesses');
      for (const name of ['z', 'surface-followup', 'a', 'scene-remediation']) {
        writeFileSync(join(web, `${name}.browser.mjs`), '');
      }
      writeFileSync(join(web, 'not-a-harness.mjs'), '');
      expect(discoverHarnesses(fixture).map((path: string) => basename(path))).toEqual([
        'scene-remediation.browser.mjs',
        'surface-followup.browser.mjs',
        'a.browser.mjs',
        'z.browser.mjs',
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects missing/malformed modules and authoritative invalid/failed executables', async () => {
    const fixture = temporary();
    try {
      await expect(
        resolveBrowser({ PLAYWRIGHT_MODULE: join(fixture, 'missing.mjs') }),
      ).rejects.toThrow('Cannot load PLAYWRIGHT_MODULE');
      const malformed = join(fixture, 'malformed.mjs');
      writeFileSync(malformed, 'export const chromium = {};');
      await expect(resolveBrowser({ PLAYWRIGHT_MODULE: malformed })).rejects.toThrow(
        'chromium.launch',
      );
      const fake = join(fixture, 'fake.mjs');
      writeFileSync(
        fake,
        'export const chromium = { executablePath() { throw Error("must not fall back"); }, async launch() { throw Error("fixture launch failure"); } };',
      );
      await expect(
        resolveBrowser({ PLAYWRIGHT_MODULE: fake, CHROMIUM_PATH: join(fixture, 'missing') }),
      ).rejects.toThrow('at explicit CHROMIUM_PATH');
      await expect(
        resolveBrowser({ PLAYWRIGHT_MODULE: fake, CHROMIUM_PATH: process.execPath }),
      ).rejects.toThrow('fixture launch failure');
      const result = spawnSync(process.execPath, [gatePath], {
        cwd: root,
        env: { ...process.env, PLAYWRIGHT_MODULE: join(fixture, 'missing.mjs') },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('[browser gate] RUN');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

it('C-RET-4 actual CLI retains fresh-process fail-fast order (fake tooling only)', () => {
  const fixture = temporary();
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'tests/web'), { recursive: true });
    const runner = join(fixture, 'scripts/run-browser-gate.mjs');
    writeFileSync(runner, readFileSync(gatePath));
    const fake = join(fixture, 'fake.mjs');
    writeFileSync(
      fake,
      'export const chromium = { async launch() { return { version: () => "FAKE-MECHANICS-ONLY", close: async () => {} }; } };',
    );
    writeFileSync(join(fixture, 'tests/web/scene-remediation.browser.mjs'), 'process.exit(19);');
    writeFileSync(
      join(fixture, 'tests/web/batch-detail.browser.mjs'),
      'throw Error("second must not run");',
    );
    const result = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: { ...process.env, PLAYWRIGHT_MODULE: fake, CHROMIUM_PATH: process.execPath },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('RUN tests/web/scene-remediation.browser.mjs');
    expect(result.stdout).not.toContain('RUN tests/web/batch-detail.browser.mjs');
    expect(result.stderr).toContain('exit 19');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Disposable fake tooling below proves driver mechanics ONLY, never browser acceptance.
function proofFixture() {
  const fixture = temporary();
  const project = join(fixture, 'project');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  mkdirSync(join(project, 'evidence'));
  writeFileSync(join(project, 'scripts/prove-browser-output.mjs'), readFileSync(proofPath));
  writeFileSync(
    join(project, 'scripts/run-browser-gate.mjs'),
    'export async function resolveBrowser() { return { modulePath: "fixture", executablePath: "fixture", version: "FAKE-MECHANICS-ONLY" }; }',
  );
  writeFileSync(join(project, '.gitignore'), 'evidence/.browser-run/\n');
  writeFileSync(join(project, 'evidence/historical.json'), '{"historical":true}\n');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      scripts: {
        verify: 'node scripts/fixture.mjs verify',
        'test:browser': 'node scripts/fixture.mjs browser',
      },
    }),
  );
  writeFileSync(
    join(project, 'scripts/fixture.mjs'),
    `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
if (process.env.TEST_DATABASE_URL || process.env.BROWSER_OUTPUT_DIR === 'inherited-must-not-leak') process.exit(29);
appendFileSync(process.env.MECHANICS_TRACE, mode + ':' + (process.env.BROWSER_OUTPUT_DIR || 'default') + '\\n');
if (mode === 'browser') {
  for (const name of ['scene', 'batch', 'shell', 'surface']) {
    if (process.env.MECHANICS_OMIT === name) continue;
    const dir = join(process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run', name);
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'results.json'), '{}');
  }
  if (process.env.MECHANICS_MUTATE) writeFileSync('evidence/historical.json', 'MUTATED');
  if (process.env.MECHANICS_OVERRIDE_MUTATE && process.env.BROWSER_OUTPUT_DIR) writeFileSync('evidence/.browser-run/scene/results.json', 'MUTATED');
}
if (process.env.MECHANICS_FAIL === mode) process.exit(23);
`,
  );
  const git = (args: string[]) => execFileSync('git', args, { cwd: project });
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const output = join(fixture, 'external');
  const trace = join(fixture, 'trace.txt');
  const run = (target = output, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/prove-browser-output.mjs', target], {
      cwd: project,
      env: {
        ...process.env,
        TEST_DATABASE_URL: 'must-not-leak',
        BROWSER_OUTPUT_DIR: 'inherited-must-not-leak',
        MECHANICS_TRACE: trace,
        PLAYWRIGHT_MODULE: process.execPath,
        CHROMIUM_PATH: process.execPath,
        ...extra,
      },
      encoding: 'utf8',
    });
  return { fixture, project, output, trace, run };
}

describe('C-RET-3 retained proof driver fail-closed mechanics', () => {
  it('runs verify/default/external/verify with files present and persists manifests/exits', () => {
    const f = proofFixture();
    try {
      const result = f.run();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const rows = readFileSync(f.trace, 'utf8').trim().split('\n');
      expect(rows).toEqual([
        'verify:default',
        'browser:default',
        `browser:${f.output}`,
        'verify:default',
      ]);
      const report = JSON.parse(readFileSync(join(f.output, '.proof/result.json'), 'utf8'));
      expect(report.passed).toBe(true);
      expect(report.commands.map((command: { status: number }) => command.status)).toEqual([
        0, 0, 0, 0,
      ]);
      for (const [, namespace] of harnesses) {
        expect(
          readFileSync(
            join(f.project, 'evidence/.browser-run', namespace!, 'results.json'),
            'utf8',
          ),
        ).toBe('{}');
        expect(readFileSync(join(f.output, namespace!, 'results.json'), 'utf8')).toBe('{}');
      }
      expect(readFileSync(join(f.output, '.proof/historical-before.json'), 'utf8')).toBe(
        readFileSync(join(f.output, '.proof/historical-after.json'), 'utf8'),
      );
    } finally {
      rmSync(f.fixture, { recursive: true, force: true });
    }
  });

  it('refuses dirty tracked/untracked starts and unsafe/existing targets before children', () => {
    const f = proofFixture();
    try {
      for (const target of ['relative', f.project, join(f.project, 'inside'), f.fixture]) {
        expect(f.run(target).status).toBe(1);
      }
      symlinkSync(f.project, join(f.fixture, 'alias'));
      expect(f.run(join(f.fixture, 'alias/new')).status).toBe(1);
      symlinkSync(f.fixture, join(f.project, 'evidence/.browser-run'));
      expect(f.run().status).toBe(1);
      rmSync(join(f.project, 'evidence/.browser-run'));
      writeFileSync(join(f.project, 'untracked.txt'), 'user file');
      expect(f.run().stderr).toContain('clean tracked/untracked');
      rmSync(join(f.project, 'untracked.txt'));
      writeFileSync(join(f.project, 'evidence/historical.json'), 'user change');
      expect(f.run().stderr).toContain('clean tracked/untracked');
      expect(readFileSync(join(f.project, 'evidence/historical.json'), 'utf8')).toBe('user change');
      expect(
        spawnSync('git', ['status', '--porcelain'], { cwd: f.project, encoding: 'utf8' }).stdout,
      ).toContain('historical.json');
      expect(() => readFileSync(f.trace)).toThrow();
    } finally {
      rmSync(f.fixture, { recursive: true, force: true });
    }
  });

  it.each(['namespace', 'default-byte-mutation'])(
    'rejects %s after successful fake children',
    (mode) => {
      const f = proofFixture();
      try {
        const result = f.run(
          f.output,
          mode === 'namespace' ? { MECHANICS_OMIT: 'surface' } : { MECHANICS_OVERRIDE_MUTATE: '1' },
        );
        expect(result.status).toBe(1);
        expect(readFileSync(f.trace, 'utf8').trim().split('\n')).toHaveLength(
          mode === 'namespace' ? 2 : 3,
        );
        const report = JSON.parse(readFileSync(join(f.output, '.proof/result.json'), 'utf8'));
        expect(report.passed).toBe(false);
        expect(report.commands.every((command: { status: number }) => command.status === 0)).toBe(
          true,
        );
        if (mode !== 'namespace')
          expect(
            readFileSync(join(f.project, 'evidence/.browser-run/scene/results.json'), 'utf8'),
          ).toBe('MUTATED');
      } finally {
        rmSync(f.fixture, { recursive: true, force: true });
      }
    },
  );

  it.each(['failure', 'mutation'])(
    'stops on %s without restoring evidence or running later gates',
    (mode) => {
      const f = proofFixture();
      try {
        const result = f.run(
          f.output,
          mode === 'failure' ? { MECHANICS_FAIL: 'browser' } : { MECHANICS_MUTATE: '1' },
        );
        expect(result.status).toBe(1);
        expect(readFileSync(f.trace, 'utf8').trim().split('\n')).toHaveLength(2);
        const report = JSON.parse(readFileSync(join(f.output, '.proof/result.json'), 'utf8'));
        expect(report.passed).toBe(false);
        if (mode === 'failure') expect(report.commands[1].status).not.toBe(0);
        else
          expect(readFileSync(join(f.project, 'evidence/historical.json'), 'utf8')).toBe('MUTATED');
      } finally {
        rmSync(f.fixture, { recursive: true, force: true });
      }
    },
  );
});
