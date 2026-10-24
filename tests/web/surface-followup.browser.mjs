/* global process, document, window, getComputedStyle, console */
/** Required in addition to npm run verify:
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:browser
 * Uses real server renderers + enabled/draft fixture data, not a production service.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL, URL, URLSearchParams } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { format, resolveConfig } from 'prettier';

import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderScriptReview } from '../../dist/src/web/render/scriptReview.js';
import { renderSeriesEditor } from '../../dist/src/web/render/seriesEditor.js';
import { renderSeriesList } from '../../dist/src/web/render/seriesList.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { changedFields, profileToValues } from '../../dist/src/web/series/fields.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

assert(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const canonicalNote = 'Approvals need a screen 1024 px or wider. This view is monitoring only.';
const computing = 'computing impact';
const failed =
  'The impact of this change could not be computed, so regeneration is blocked. Editing and regeneration are both disabled until it can be computed — this prevents a change whose cost you could not see.';
const output = process.env.BROWSER_OUTPUT_DIR
  ? pathToFileURL(resolve(process.env.BROWSER_OUTPUT_DIR) + '/')
  : new URL('../../evidence/.browser-run/', import.meta.url);
const widths = [1440, 1024, 768, 767, 480, 390, 320];
mkdirSync(output, { recursive: true });
const css = APP_CSS;
const series = { ...FIXTURES['series.get'], status: 'active' };
const values = { ...profileToValues(series.profile), name: series.name, slug: series.slug };
const editor = renderSeriesEditor({
  mode: 'edit',
  status: 'active',
  detail: series,
  values: { ...values, name: values.name + ' edited' },
  initial: values,
  changed: changedFields(values, { ...values, name: values.name + ' edited' }),
  errors: {},
});
const detail = FIXTURES['video.get'];
const draft = {
  ...FIXTURES['script.get'],
  status: 'draft',
  approved_at: null,
  claims: FIXTURES['script.get'].claims.filter((claim) => claim.status === 'sourced'),
};
const preview = { ...FIXTURES['video.invalidation_preview'], revision: draft.revision };
const ready = `Script rev ${draft.revision} → rev ${draft.revision + 1} · wording only`;
const posts = [];
const surfaces = {
  shell: { content: '<p>Degraded shell target evidence</p>' },
  list: {
    content: renderSeriesList({
      state: 'ready',
      rows: [{ summary: { ...series, name: 'LongSeriesName'.repeat(24) }, inFlightBatches: 2 }],
      now: Date.parse(series.updated_at),
    }),
  },
  script: { content: renderScriptReview({ detail, script: draft }), module: 'scriptReview' },
  editor: {
    content: editor.main,
    aside: { label: 'Series actions', content: editor.aside },
    module: 'seriesEditor',
  },
};
const pages = Object.fromEntries(
  Object.entries(surfaces).map(([name, surface]) => [
    name,
    renderShell(
      buildShellModel({
        title: name === 'editor' ? 'Series profile' : name,
        nav: 'series',
        overview: { ...FIXTURES['overview.get'], degraded: ['Provider unavailable'] },
        session: FIXTURES['auth.session'],
        content: surface.content,
        ...(surface.aside ? { aside: surface.aside } : {}),
        assets: { extraScripts: surface.module ? [`/assets/client/${surface.module}.js`] : [] },
      }),
    ),
  ]),
);
// Serve built browser ESM only from this local fixture harness.
const server = createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      posts.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/invalidation-preview')) return res.end(JSON.stringify(preview));
      if (req.url.endsWith('/script') || req.url.endsWith('/script/approve'))
        return res.end(JSON.stringify({ ...draft, revision: draft.revision + 1 }));
      res.end('{}');
    });
    return;
  }
  if (req.url === '/api/videos/' + detail.id) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(detail));
  }
  if (req.url === '/shared/stages.js' || req.url === '/shared/states.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(readFileSync(new URL('../../dist/src' + req.url, import.meta.url)));
  }
  if (req.url === '/assets/app.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(css);
  }
  if (req.url?.startsWith('/assets/')) {
    const path = req.url.slice('/assets/'.length);
    if (!/^[a-zA-Z0-9/.-]+\.js$/.test(path) || path.includes('..')) {
      res.statusCode = 404;
      return res.end();
    }
    try {
      res.setHeader('content-type', 'text/javascript');
      return res.end(readFileSync(new URL('../../dist/src/web/' + path, import.meta.url)));
    } catch {
      res.statusCode = 404;
      return res.end();
    }
  }
  res.setHeader('content-type', 'text/html');
  res.end(pages[req.url?.slice(1)] ?? pages.shell);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
const dispatch = [];
const asyncSummary = [];

async function summaryGates(page, width) {
  const gates = await page.locator('#script-apply, #script-regenerate').evaluateAll((elements) =>
    elements.map((element) => {
      let hiddenByDisplayNone = false;
      for (let node = element; node; node = node.parentElement)
        if (getComputedStyle(node).display === 'none') hiddenByDisplayNone = true;
      return { id: element.id, disabled: element.disabled, hiddenByDisplayNone };
    }),
  );
  assert.equal(gates.length, 2);
  assert(
    gates.every((gate) => width >= 768 || gate.hiddenByDisplayNone),
    JSON.stringify(gates),
  );
  assert.equal(await page.locator('.script-impact-summary').isVisible(), width < 768);
  assert.equal(await page.locator('[data-monitor-for="script-title"]').isVisible(), width < 768);
  assert.notEqual(
    await page.locator('[data-monitor-for="script-title"]').getAttribute('readonly'),
    null,
  );
  return gates;
}

async function waitSummary(page, expected) {
  await page.waitForFunction(
    (text) =>
      document.querySelector('[data-monitor-text-for="script-impact-message"]')?.textContent ===
      text,
    expected,
  );
  assert.equal(
    await page.locator('[data-monitor-text-for="script-impact-message"]').textContent(),
    expected,
  );
}

async function clickPost(page, selector, path) {
  const request = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url() === base + path,
  );
  await page.locator(selector).click();
  const sent = await request;
  const response = await sent.response();
  assert.equal(response.status(), 200);
  assert(sent.postData()?.length > 0, 'actual nonempty POST payload');
  return { path, method: sent.method(), body: sent.postData(), status: response.status() };
}

async function phoneTabProof(page, surface, label) {
  const prohibited = page.locator(
    surface === 'script' ? '#script-approve, #script-apply, #script-regenerate' : '.series-save',
  );
  assert.equal(await prohibited.count(), surface === 'script' ? 3 : 1);
  const gates = await prohibited.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.id,
      disabled: element.disabled,
      hiddenByDisplayNone: (() => {
        for (let node = element; node; node = node.parentElement)
          if (getComputedStyle(node).display === 'none') return true;
        return false;
      })(),
    })),
  );
  // Select controls independently of readonly/tabindex so regressions cannot
  // silently remove them from the expected set. Editor choice summaries are
  // plain paragraphs, not sequential focus targets.
  const expected = await page
    .locator('textarea[data-monitor-for], input[data-monitor-for]')
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
        )
        .map((element) => ({ id: element.id, readOnly: element.readOnly })),
    );
  assert(expected.length > 0, `${label}: visible monitoring fields exist`);
  assert(
    expected.every((field) => field.id && field.readOnly),
    `${label}: readonly field IDs`,
  );
  const expectedIds = expected.map((field) => field.id);
  assert.equal(new Set(expectedIds).size, expectedIds.length, `${label}: unique monitoring IDs`);
  const tabSequence = [];
  for (let tab = 0; tab < 70; tab++) {
    await page.keyboard.press('Tab');
    assert(
      !(await prohibited.evaluateAll((elements) =>
        elements.some((element) => element === document.activeElement),
      )),
      `${label}: mutation control reached by Tab`,
    );
    tabSequence.push(await page.evaluate(() => document.activeElement.id));
  }
  const reachedIds = expectedIds.filter((id) => tabSequence.includes(id));
  assert.deepEqual(
    reachedIds,
    expectedIds,
    `${label}: every visible readonly monitor reached by Tab`,
  );
  return { expectedIds, reachedIds, presses: tabSequence.length, tabSequence, gates };
}

try {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const surface of Object.keys(surfaces)) {
        await page.goto(base + '/' + surface);
        const metrics = await page.evaluate(() => {
          const visible = (element) =>
            element !== null &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden';
          const link = document.querySelector('.degraded-link').getBoundingClientRect();
          const wrap = document.querySelector('.series-table-wrap');
          return {
            pageWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            healthTarget: { width: link.width, height: link.height },
            gates: [
              '#script-approve',
              '#script-apply',
              '#script-regenerate',
              '.series-save',
              '.series-batch button',
            ].map((selector) => ({
              selector,
              visible: visible(document.querySelector(selector)),
              disabled: document.querySelector(selector)?.disabled ?? null,
            })),
            editable: [...document.querySelectorAll('textarea, input:not([type="hidden"]), select')]
              .filter((el) => visible(el) && !el.readOnly)
              .map((el) => el.id),
            note: visible(document.querySelector('.script-width-note, .series-width-note')),
            summary: visible(document.querySelector('.script-impact-summary')),
            region: wrap
              ? {
                  role: wrap.getAttribute('role'),
                  label: wrap.getAttribute('aria-label'),
                  tabIndex: wrap.tabIndex,
                  width: wrap.clientWidth,
                  scroll: wrap.scrollWidth,
                }
              : null,
          };
        });

        assert(
          metrics.pageWidth <= width,
          `${surface} ${width}: page overflow ${metrics.pageWidth}`,
        );
        assert(metrics.healthTarget.width >= 24 && metrics.healthTarget.height >= 24);
        if (surface === 'script' || surface === 'editor') {
          assert.equal(
            await page.locator('.script-width-note, .series-width-note').textContent(),
            canonicalNote,
          );
          assert.equal(metrics.note, width < 768);
          if (width < 768) {
            assert.deepEqual(metrics.editable, []);
            assert(
              metrics.gates.every((gate) => !gate.visible),
              JSON.stringify({ surface, width, javaScriptEnabled, gates: metrics.gates }),
            );
          } else {
            assert(metrics.gates.some((gate) => gate.visible));
            const primary = metrics.gates.find(
              (gate) =>
                gate.selector === (surface === 'script' ? '#script-approve' : '.series-save'),
            );
            assert.equal(primary.disabled, false, 'enabled fixture primary gate');
          }
          if (surface === 'script') assert.equal(metrics.summary, width < 768);
        }
        if (surface === 'list' && width >= 768) {
          assert.equal(metrics.region.role, 'region');
          assert.equal(metrics.region.label, 'Series list');
          assert.equal(metrics.region.tabIndex, 0);
          let tabs = 0;
          while (
            !(await page
              .locator('.series-table-wrap')
              .evaluate((el) => el === document.activeElement)) &&
            tabs < 50
          ) {
            await page.keyboard.press('Tab');
            tabs++;
          }
          assert(tabs > 0 && tabs < 50, 'series region reached with real Tab presses');
          metrics.region.tabs = tabs;
          const ring = await page
            .locator('.series-table-wrap')
            .evaluate((el) => getComputedStyle(el).outlineStyle);
          assert.notEqual(ring, 'none');
          await page.keyboard.press('ArrowRight');
          for (
            let tries = 0;
            tries < 20 &&
            (await page.locator('.series-table-wrap').evaluate((el) => el.scrollLeft)) === 0;
            tries++
          )
            await setTimeout(50);
          assert((await page.locator('.series-table-wrap').evaluate((el) => el.scrollLeft)) > 0);
        }
        if (width < 768 && (surface === 'script' || surface === 'editor')) {
          metrics.tabProof = await phoneTabProof(
            page,
            surface,
            `${surface} ${width} JS=${javaScriptEnabled}`,
          );
          metrics.tabSequence = metrics.tabProof.tabSequence;
          const ax = await page.locator('body').ariaSnapshot();
          assert(
            !/button "(?:Apply edit|Apply and regenerate|Approve script|Save changes)/.test(ax),
          );
          if (surface === 'script') {
            metrics.summaryText = await page
              .locator('[data-monitor-text-for="script-impact-message"]')
              .textContent();
            assert.equal(metrics.summaryText, 'No unsaved changes');
            assert(ax.includes(metrics.summaryText));
          }
          writeFileSync(new URL(`ax-${surface}-${width}-${javaScriptEnabled}.txt`, output), ax);
        }
        results.push({ javaScriptEnabled, surface, width, ...metrics });
        if (!javaScriptEnabled && [1440, 768, 390, 320].includes(width))
          await page.screenshot({
            path: new URL(`${surface}-${width}.png`, output).pathname,
            fullPage: true,
          });
      }
    }
    if (javaScriptEnabled) {
      for (const width of widths) {
        for (const outcome of ['ready', 'failed']) {
          await page.setViewportSize({ width: 1440, height: 900 });
          let release;
          const delayed = new Promise((resolve) => {
            release = resolve;
          });
          const routeHandler = async (route) => {
            assert.equal(route.request().method(), 'POST');
            assert.equal(
              route.request().postDataJSON().script_content.title,
              'Delayed desktop edit',
            );
            await delayed;
            await route.fulfill({
              status: outcome === 'ready' ? 200 : 503,
              contentType: 'application/json',
              body: JSON.stringify(outcome === 'ready' ? preview : {}),
            });
          };
          await page.route('**/api/videos/*/invalidation-preview', routeHandler);
          await page.goto(base + '/script');
          const requested = page.waitForRequest(
            (req) => req.method() === 'POST' && req.url().endsWith('/invalidation-preview'),
          );
          await page.locator('#script-title').fill('Delayed desktop edit');
          await requested;
          await page.setViewportSize({ width, height: 900 });
          await waitSummary(page, computing);
          await summaryGates(page, width);
          await page.screenshot({
            path: new URL(`async-${width}-${outcome}-computing.png`, output).pathname,
            fullPage: true,
          });
          release();
          await waitSummary(page, outcome === 'ready' ? ready : failed);
          const gates = await summaryGates(page, width);
          assert(
            gates.every((gate) => gate.disabled === (outcome === 'failed')),
            'ready controls enabled but CSS-hidden',
          );
          const tabProof =
            width < 768
              ? await phoneTabProof(page, 'script', `resolved ${outcome} ${width}`)
              : null;
          const ax = await page.locator('body').ariaSnapshot();
          assert(
            !ax.includes(computing),
            'resolved accessibility tree must not retain computing impact',
          );
          if (width < 768)
            assert(
              ax.includes(outcome === 'ready' ? ready : failed),
              'resolved summary in a11y tree',
            );
          writeFileSync(new URL(`async-ax-${width}-${outcome}.txt`, output), ax);
          asyncSummary.push({
            width,
            outcome,
            summaryVisible: await page.locator('.script-impact-summary').isVisible(),
            before: computing,
            after: await page
              .locator('[data-monitor-text-for="script-impact-message"]')
              .textContent(),
            gates,
            tabProof,
          });
          await page.screenshot({
            path: new URL(`async-${width}-${outcome}.png`, output).pathname,
            fullPage: true,
          });
          await page.unroute('**/api/videos/*/invalidation-preview', routeHandler);
        }
      }
      for (const width of [768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const action of ['apply', 'regenerate', 'approve']) {
          await page.goto(base + '/script');
          if (action !== 'approve') {
            await page.locator('#script-title').fill('Dispatch ' + action);
            await page.waitForFunction(
              () =>
                document.querySelector('[data-impact]').getAttribute('data-impact-state') ===
                'ready',
            );
          }
          const rerun =
            action === 'regenerate'
              ? page.waitForResponse(
                  (res) =>
                    res.request().method() === 'POST' && res.url().endsWith('/stages/SB/retry'),
                )
              : null;
          const sent = await clickPost(
            page,
            '#script-' + action,
            '/api/videos/' + detail.id + (action === 'approve' ? '/script/approve' : '/script'),
          );
          assert.equal(JSON.parse(sent.body).revision, draft.revision);
          if (rerun) assert.equal((await rerun).status(), 200);
          dispatch.push({ width, javaScriptEnabled, action, ...sent, rerun: rerun !== null });
          await page.screenshot({
            path: new URL(`dispatch-${width}-${action}.png`, output).pathname,
            fullPage: true,
          });
        }
      }
      for (const surface of ['script', 'editor']) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(base + '/' + surface);
        const selector = surface === 'script' ? '#script-title' : '#field-name';
        await page.locator(selector).fill('Unsaved desktop edit');
        await page.setViewportSize({ width: 390, height: 900 });
        const key = surface === 'script' ? 'script-title' : 'name';
        await page.locator(`[data-monitor-for="${key}"]`).waitFor({ state: 'visible' });
        assert.equal(
          await page.locator(`[data-monitor-for="${key}"]`).inputValue(),
          'Unsaved desktop edit',
        );
      }
    }
    for (const width of [768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(base + '/editor');
      const sent = await clickPost(page, '.series-save', '/series/' + series.id);
      assert(new URLSearchParams(sent.body).has('revision'));
      dispatch.push({ width, javaScriptEnabled, action: 'save', ...sent });
    }
    assert.deepEqual(errors, [], 'browser runtime errors');
    await context.close();
  }
  writeFileSync(
    new URL('browser-results.json', output),
    await format(
      JSON.stringify(
        {
          node: process.version,
          browser: browser.version(),
          results,
          dispatch,
          asyncSummary,
          posts,
          resizeSync: 'script and series passed',
        },
        null,
        2,
      ),
      { ...(await resolveConfig(output.pathname)), parser: 'json' },
    ),
  );
  console.log(
    `PASS: ${results.length} surface/viewport/JS combinations; ${dispatch.length} desktop dispatches; ${asyncSummary.length} delayed previews; phone Tab exclusion + a11y tree + no-JS default; Tab + ArrowRight; resize sync; screenshots in ${output.pathname}`,
  );
} finally {
  await browser.close();
  server.close();
}
