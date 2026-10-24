/* global process, console */
// Opt-in real proof; never discovered as a *.browser.mjs harness.
import assert from 'node:assert/strict';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { resolveBrowser } from './run-browser-gate.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const namespaces = ['scene', 'batch', 'shell', 'surface'];
const defaultOutput = join(root, 'evidence/.browser-run');
const env = { ...process.env };
delete env.TEST_DATABASE_URL; // This proof is explicitly non-DB; skips are not SQL passes.
delete env.BROWSER_OUTPUT_DIR;

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
function clean() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(
    status,
    '',
    `Requires clean tracked/untracked checkout; no restoration performed:\n${status}`,
  );
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function digest(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function historical() {
  return git(['ls-files', '-z', '--', 'evidence'])
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((path) => {
      assert.ok(lstatSync(join(root, path)).isFile(), `Not a regular historical file: ${path}`);
      return { path, ...digest(join(root, path)) };
    });
}
function manifest(directory, requireNamespaces = true) {
  const files = [];
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `Output symlink refused: ${path}`);
      if (stat.isDirectory()) visit(path);
      else {
        assert.ok(stat.isFile(), `Nonregular output: ${path}`);
        files.push({ path: relative(directory, path), ...digest(path) });
      }
    }
  }
  assert.ok(!lstatSync(directory).isSymbolicLink(), `Output root symlink refused: ${directory}`);
  // Include ALL files, except the external proof's own changing logs/manifests.
  for (const name of readdirSync(directory).sort()) {
    if (name === '.proof' && join(directory, name) === proof) continue;
    const path = join(directory, name);
    assert.ok(!lstatSync(path).isSymbolicLink(), `Output symlink refused: ${path}`);
    if (lstatSync(path).isDirectory()) visit(path);
    else {
      assert.ok(lstatSync(path).isFile(), `Nonregular output: ${path}`);
      files.push({ path: name, ...digest(path) });
    }
  }
  for (const name of requireNamespaces ? namespaces : []) {
    const path = join(directory, name);
    assert.ok(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      `Missing namespace: ${path}`,
    );
    const members = files.filter((file) => file.path.startsWith(`${name}${sep}`));
    assert.ok(members.length > 0, `Empty namespace: ${path}`);
    assert.ok(
      members.some((file) => file.path.endsWith('.json')),
      `No JSON in ${path}`,
    );
  }
  return files;
}

let proof;
const report = { passed: false, commands: [] };
function save(name, value) {
  writeFileSync(join(proof, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
}
function run(label, script, output) {
  const log = join(proof, `${label}.log`);
  const fd = openSync(log, 'wx');
  let child;
  const started = new Date().toISOString();
  try {
    child = spawnSync('npm', ['run', script], {
      cwd: root,
      env: { ...env, ...(output ? { BROWSER_OUTPUT_DIR: output } : {}) },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const result = {
    label,
    command: ['npm', 'run', script],
    cwd: root,
    browserOutput: output || null,
    databaseURL: 'unset',
    started,
    ended: new Date().toISOString(),
    status: child.status,
    signal: child.signal,
    error: child.error?.message || null,
    log,
  };
  report.commands.push(result);
  save('result.json', report);
  console.log(
    `[output proof] ${label}: exit ${child.status}, signal ${child.signal || 'none'}; ${log}`,
  );
  assert.ok(!child.error && child.status === 0, `${label} failed; see ${log}`);
}

async function main() {
  assert.equal(
    process.argv.length,
    3,
    'Usage: node scripts/prove-browser-output.mjs /fresh/absolute/external-directory',
  );
  assert.equal(realpathSync(process.cwd()), root, 'Run from the project cwd');
  const target = process.argv[2];
  assert.ok(isAbsolute(target), 'External output must be absolute');
  const external = resolve(target);
  // Require an existing canonical parent: do not follow symlinks into a checkout.
  assert.equal(
    realpathSync(dirname(external)),
    dirname(external),
    'External parent must be canonical (no symlink aliases)',
  );
  const common = resolve(root, git(['rev-parse', '--git-common-dir']).trim());
  for (const protectedRoot of [root, dirname(common)]) {
    assert.ok(
      !inside(protectedRoot, external) && !inside(external, protectedRoot),
      'External target overlaps repository',
    );
  }
  assert.ok(!exists(external), 'External target must be fresh and nonexistent');
  clean();
  if (exists(defaultOutput)) manifest(defaultOutput, false); // Reject ignored symlinks before writes.
  assert.ok(
    isAbsolute(env.PLAYWRIGHT_MODULE || '') && isAbsolute(env.CHROMIUM_PATH || ''),
    'Supply explicit absolute PLAYWRIGHT_MODULE and CHROMIUM_PATH; no downloads',
  );
  mkdirSync(external); // Exclusive creation. Never delete or restore any output on failure.
  proof = join(external, '.proof');
  mkdirSync(proof);
  Object.assign(report, {
    root,
    external,
    defaultOutput,
    node: process.version,
    nodePath: process.execPath,
    commit: git(['rev-parse', 'HEAD']).trim(),
    tree: git(['rev-parse', 'HEAD^{tree}']).trim(),
    branch: git(['branch', '--show-current']).trim(),
    sql: 'BLOCKED / non-DB proof only',
  });
  save('result.json', report);
  const baseline = historical();
  assert.ok(baseline.length > 0, 'No tracked historical evidence');
  save('historical-before.json', baseline);
  report.browser = await resolveBrowser(env); // Real launch/close; selected versions/paths recorded.
  save('result.json', report);
  function audit(label) {
    const current = historical();
    save(`historical-${label}.json`, current);
    assert.deepEqual(current, baseline, 'Historical evidence changed; no restoration performed');
    clean();
  }
  run('01-verify-before', 'verify');
  audit('pre-browser');
  run('02-browser-default', 'test:browser');
  const defaults = manifest(defaultOutput);
  save('default-after-default.json', defaults);
  audit('default');
  run('03-browser-external', 'test:browser', external);
  save('external-after-external.json', manifest(external));
  const afterExternal = manifest(defaultOutput);
  save('default-after-external.json', afterExternal);
  assert.deepEqual(afterExternal, defaults, 'External run changed default output');
  audit('external');
  run('04-verify-after', 'verify'); // Outputs intentionally remain present throughout.
  const finalDefaults = manifest(defaultOutput);
  save('default-after-verify.json', finalDefaults);
  assert.deepEqual(finalDefaults, defaults, 'Final verify changed default output');
  const externalFinal = manifest(external);
  save('external-after-verify.json', externalFinal);
  assert.deepEqual(
    externalFinal,
    JSON.parse(readFileSync(join(proof, 'external-after-external.json'), 'utf8')),
    'Final verify changed external output',
  );
  audit('after');
  report.passed = true;
  report.historicalFiles = baseline.length;
  report.defaultFiles = defaults.length;
  report.externalFiles = externalFinal.length;
  save('result.json', report);
  console.log(
    `[output proof] PASS: four namespaces, byte-identical historical/default outputs, clean checkout. Evidence: ${proof}`,
  );
}
main().catch((error) => {
  report.error = error.message;
  if (proof) save('result.json', report);
  console.error(`[output proof] FAIL: ${error.message}`);
  process.exitCode = 1;
});
