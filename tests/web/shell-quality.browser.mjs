/* global process, document, getComputedStyle, console */
/** Local full-shell fixture regression, not an authenticated application server.
 * npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 * CHROMIUM_PATH=/path/to/chromium node tests/web/shell-quality.browser.mjs
 * Results default to evidence/shell-quality/browser-results.json; override with
 * BROWSER_OUTPUT_DIR (absolute path). No production requests or approval POSTs.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderQualityPanel } from '../../dist/src/web/render/quality.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to playwright/index.mjs');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = resolve(process.env.BROWSER_OUTPUT_DIR ?? 'evidence/shell-quality');
mkdirSync(output, { recursive: true });
const widths = [1440, 1024, 768, 767, 480, 390, 320];
const monitoring = 'Approvals need a screen 1024 px or wider. This view is monitoring only.';
const fixture = FIXTURES['render.get'];
const states = {
  ready: { render: fixture, expected: 'ready' },
  unwired: { render: fixture, approveWired: false, expected: 'blocked' },
  'qc-failed': {
    render: {
      ...fixture,
      qc: {
        ...fixture.qc,
        status: 'fail',
        checks: fixture.qc.checks.map((check, index) =>
          index === 0 ? { ...check, pass: false } : check,
        ),
      },
    },
    expected: 'blocked',
  },
  running: { render: { ...fixture, status: 'running' }, expected: 'blocked' },
  failed: {
    render: { ...fixture, status: 'failed', video: null },
    expected: 'blocked',
  },
  empty: { render: null, expected: 'blocked' },
  approved: {
    render: { ...fixture, approved: true, approved_at: fixture.qc.checked_at },
    expected: 'approved',
  },
};
const pages = Object.fromEntries(
  Object.entries(states).map(([state, input]) => [
    '/' + state,
    renderShell(
      buildShellModel({
        title: 'Render and quality checks',
        nav: 'series',
        overview: { ...FIXTURES['overview.get'], degraded: ['Provider unavailable'] },
        session: FIXTURES['auth.session'],
        content: renderQualityPanel({
          detail: FIXTURES['video.get'],
          revision: 7,
          approveWired: input.approveWired ?? true,
          render: input.render,
        }),
      }),
    ),
  ]),
);
const server = createServer((req, res) => {
  if (req.url === '/assets/app.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(APP_CSS);
  }
  if (req.url?.startsWith('/assets/')) {
    const path = req.url.slice('/assets/'.length);
    if (/^[a-zA-Z0-9/.-]+\.js$/.test(path) && !path.includes('..')) {
      try {
        res.setHeader('content-type', 'text/javascript');
        return res.end(readFileSync(new URL('../../dist/src/web/' + path, import.meta.url)));
      } catch {
        // Missing fixture assets fail the response and are checked by the harness.
      }
    }
  }
  if (req.method === 'GET' && pages[req.url]) {
    res.setHeader('content-type', 'text/html');
    return res.end(pages[req.url]);
  }
  // Media is deliberately not fabricated; this harness tests controls, not decoding.
  res.statusCode = 404;
  res.end();
});

async function computed(page, selector) {
  const element = page.locator(selector);
  assert.equal(await element.count(), 1, selector);
  return element.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      display: style.display,
      visibility: style.visibility,
      visible:
        el.getClientRects().length > 0 &&
        style.display !== 'none' &&
        style.visibility === 'visible' &&
        box.width > 0 &&
        box.height > 0,
      width: box.width,
      height: box.height,
    };
  });
}

async function axNode(cdp, tree, selector) {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  return tree.nodes.find((entry) => entry.backendDOMNodeId === node.backendNodeId) ?? null;
}

async function tabSequence(page) {
  // Start before all controls, and walk the real sequence twice. No programmatic
  // focus of the target: doing so could mask a broken keyboard reachability rule.
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  const count = await page.locator('a, button, textarea, input, select, video, [tabindex]').count();
  const reached = new Set();
  let gateReached = false;
  for (let i = 0; i < count * 2 + 2; i++) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => ({
      id: document.activeElement?.id,
      gate: !!document.activeElement?.closest('#quality-approval'),
    }));
    if (active.id) reached.add(active.id);
    gateReached ||= active.gate;
  }
  return { ids: [...reached], gateReached };
}

let browser;
const results = [];
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const page = await context.newPage();
      const errors = [];
      const loadedScripts = new Set();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.url().includes('/assets/') && response.url().endsWith('.js')) {
          assert.equal(response.status(), 200, response.url());
          loadedScripts.add(new URL(response.url()).pathname);
        }
      });
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [state, input] of Object.entries(states)) {
          const label = `${state} ${width} JS=${javaScriptEnabled}`;
          await page.goto(origin + '/' + state);
          if (javaScriptEnabled) {
            await page.waitForFunction(() => !!globalThis.reelsAnnounce);
          }
          const targets = {};
          for (const selector of ['.status-cause', '.rail-signout-button']) {
            const metric = await computed(page, selector);
            assert.equal(metric.visible, width >= 1024, `${label} ${selector} visibility`);
            if (width >= 1024) {
              assert.ok(
                metric.width >= 24 && metric.height >= 24,
                `${label} ${selector}: ${JSON.stringify(metric)}`,
              );
            } else {
              assert.equal(
                await page.locator(selector).boundingBox(),
                null,
                `${label} hidden target`,
              );
            }
            targets[selector] = metric;
          }
          const gate = await computed(page, '#quality-approval');
          const note = await computed(page, '#quality-band-note');
          assert.equal(gate.visible, width >= 768, `${label} gate visibility`);
          assert.equal(note.visible, width < 768, `${label} monitoring visibility`);
          assert.equal(await page.locator('#quality-band-note').textContent(), monitoring, label);
          assert.equal(
            await page.locator('#quality-approval').getAttribute('data-approval'),
            input.expected,
            label,
          );
          if (width < 768) assert.equal(gate.display, 'none', `${label} gate display`);
          else assert.equal(note.display, 'none', `${label} note display`);

          const cdp = await context.newCDPSession(page);
          let ax;
          try {
            const tree = await cdp.send('Accessibility.getFullAXTree');
            const gateNode = await axNode(cdp, tree, '#quality-approval');
            const buttonNode = await axNode(cdp, tree, '#quality-approve-button');
            // Match DOM backend IDs, not ancestor names containing "Approve final".
            ax = {
              gateExposed: !!gateNode && !gateNode.ignored,
              buttonExposed: !!buttonNode && !buttonNode.ignored,
              noteExposed: tree.nodes.some(
                (node) => !node.ignored && node.name?.value === monitoring,
              ),
            };
            assert.equal(ax.gateExposed, width >= 768, `${label} AX gate`);
            assert.equal(
              ax.buttonExposed,
              width >= 768 && state !== 'approved',
              `${label} AX button`,
            );
            assert.equal(ax.noteExposed, width < 768, `${label} AX monitoring note`);
            if (ax.buttonExposed) {
              assert.equal(buttonNode.role?.value, 'button', label);
              assert.equal(buttonNode.name?.value, 'Approve final', label);
              const disabled =
                buttonNode.properties?.find((property) => property.name === 'disabled')?.value
                  .value ?? false;
              assert.equal(disabled, input.expected !== 'ready', `${label} AX disabled`);
            }
          } finally {
            await cdp.detach();
          }
          const tab = await tabSequence(page);
          assert.equal(tab.gateReached, width >= 768, `${label} Tab gate`);
          assert.equal(
            tab.ids.includes('quality-approve-button'),
            width >= 768 && state === 'ready',
            `${label} Tab approve`,
          );
          assert.equal(
            tab.ids.includes('quality-note'),
            width >= 768 && state === 'ready',
            `${label} Tab note input`,
          );
          let approve = null;
          if (state !== 'approved') {
            assert.equal(
              await page.locator('#quality-approve-button').isDisabled(),
              input.expected !== 'ready',
              label,
            );
            if (width >= 768) {
              approve = await computed(page, '#quality-approve-button');
              assert.ok(approve.width >= 44 && approve.height >= 44, `${label} approval target`);
            }
          }
          results.push({ state, width, javaScriptEnabled, targets, gate, note, ax, tab, approve });
        }
      }
      assert.deepEqual(errors, [], 'browser runtime errors');
      assert.equal(
        loadedScripts.has('/assets/client/shell.js'),
        javaScriptEnabled,
        'compiled shell loaded only with JS enabled',
      );
      assert.equal(
        loadedScripts.has('/assets/client/behaviours.js'),
        javaScriptEnabled,
        'shell dependency loaded',
      );
    } finally {
      await context.close();
    }
  }
  assert.equal(results.length, widths.length * 2 * Object.keys(states).length);
  assert.equal(
    new Set(
      results.map(
        ({ state, width, javaScriptEnabled }) => `${state}/${width}/${javaScriptEnabled}`,
      ),
    ).size,
    results.length,
  );
  writeFileSync(
    resolve(output, 'browser-results.json'),
    JSON.stringify(
      { browser: browser.version(), widths, states: Object.keys(states), results },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS: ${results.length} state/width/JS cases; computed shell targets, approval display/AX/actual Tab; ${output}/browser-results.json`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
