/* global process, console */
import { constants, readdirSync, accessSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const order = ['scene-remediation', 'batch-detail', 'shell-quality', 'surface-followup'];
const setup =
  'Set PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs and CHROMIUM_PATH=/absolute/path/to/chromium. ' +
  'Alternatively install Playwright locally and its browser (npm exec -- playwright install chromium). ' +
  'No tooling is downloaded automatically; see docs/BROWSER_GATE.md.';

export function discoverHarnesses(projectRoot = root) {
  const directory = join(projectRoot, 'tests/web');
  const names = readdirSync(directory).filter((name) => name.endsWith('.browser.mjs'));
  const preferred = order.map((name) => `${name}.browser.mjs`);
  const sorted = [
    ...preferred.filter((name) => names.includes(name)),
    ...names.filter((name) => !preferred.includes(name)).sort(),
  ];
  if (!sorted.length) throw new Error('No browser harnesses found in tests/web.');
  return sorted.map((name) => join(directory, name));
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cachedBrowsers(cache) {
  if (!existsSync(cache)) return [];
  return readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap((name) =>
      [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ].map((suffix) => join(cache, name, suffix)),
    );
}

export async function resolveBrowser(env = process.env) {
  let modulePath;
  let chromium;
  try {
    if (env.PLAYWRIGHT_MODULE) {
      modulePath = resolve(env.PLAYWRIGHT_MODULE);
    } else {
      for (const name of ['playwright', 'playwright-core']) {
        try {
          modulePath = require.resolve(name);
          break;
        } catch {
          // Try the next locally installed package; never search unrelated projects.
        }
      }
    }
    if (!modulePath) throw new Error('No locally installed playwright or playwright-core package.');
    ({ chromium } = await import(pathToFileURL(modulePath).href));
    if (!chromium?.launch) throw new Error('Module does not export chromium.launch.');
  } catch (error) {
    throw new Error(`Cannot load PLAYWRIGHT_MODULE: ${error.message}\n${setup}`);
  }

  const candidates = env.CHROMIUM_PATH
    ? [resolve(env.CHROMIUM_PATH)]
    : [
        chromium.executablePath(),
        ...cachedBrowsers(env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright')),
        ...cachedBrowsers(join(homedir(), 'Library/Caches/ms-playwright')),
        ...(env.PATH || '')
          .split(delimiter)
          .flatMap((directory) =>
            ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].map((name) =>
              join(directory, name),
            ),
          ),
      ];
  const failures = [];
  for (const executablePath of new Set(candidates)) {
    if (!executable(executablePath)) {
      failures.push(`${executablePath}: not executable`);
      continue;
    }
    try {
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox'],
      });
      const version = browser.version();
      await browser.close();
      return { modulePath, executablePath, version };
    } catch (error) {
      failures.push(`${executablePath}: ${error.message}`);
    }
  }
  throw new Error(
    `No usable Chromium${env.CHROMIUM_PATH ? ' at explicit CHROMIUM_PATH' : ' discovered'}.\n${setup}\n${failures.join('\n')}`,
  );
}

async function main() {
  // Run each harness in a fresh process: fixtures, servers and launch patches cannot leak.
  if (process.argv[2] === '--harness') {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    const launch = chromium.launch.bind(chromium);
    // Older harnesses omit executablePath. Enforce the selected executable for all,
    // preserving their other launch options and every original assertion unchanged.
    chromium.launch = (options = {}) =>
      launch({ ...options, executablePath: process.env.CHROMIUM_PATH });
    await import(pathToFileURL(resolve(process.argv[3])).href);
    return;
  }
  const harnesses = discoverHarnesses();
  const browser = await resolveBrowser();
  console.log(`[browser gate] Playwright: ${browser.modulePath}`);
  console.log(`[browser gate] Chromium ${browser.version}: ${browser.executablePath}`);
  console.log(`[browser gate] ${harnesses.length} harnesses; any failure stops the gate.`);
  for (const harness of harnesses) {
    console.log(`[browser gate] RUN ${harness.slice(root.length)}`);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--harness', harness],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          PLAYWRIGHT_MODULE: browser.modulePath,
          CHROMIUM_PATH: browser.executablePath,
        },
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Harness failed: ${harness} (exit ${result.status}, signal ${result.signal || 'none'}). ${result.error?.message || ''}`,
      );
    }
  }
  console.log(`[browser gate] PASS: all ${harnesses.length} present harnesses.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[browser gate] FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
