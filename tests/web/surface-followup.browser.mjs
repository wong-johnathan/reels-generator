/* global process, document, window, getComputedStyle, console */
/** Local-only browser evidence. Run npm run build first, then:
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/web/surface-followup.browser.mjs
 * Uses real server renderers + enabled/draft fixture data, not a production service.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderScriptReview } from '../../dist/src/web/render/scriptReview.js';
import { renderSeriesEditor } from '../../dist/src/web/render/seriesEditor.js';
import { renderSeriesList } from '../../dist/src/web/render/seriesList.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { changedFields, profileToValues } from '../../dist/src/web/series/fields.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = resolve(process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run', 'surface');
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
try {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of [1440, 1024, 768, 480, 390, 320]) {
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
          await page.locator('.series-table-wrap').focus();
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
        results.push({ javaScriptEnabled, surface, width, ...metrics });
        if (!javaScriptEnabled && [1440, 768, 390, 320].includes(width))
          await page.screenshot({
            path: resolve(output, `${surface}-${width}.png`),
            fullPage: true,
          });
      }
    }
    if (javaScriptEnabled) {
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
    assert.deepEqual(errors, [], 'browser runtime errors');
    await context.close();
  }
  writeFileSync(
    resolve(output, 'browser-results.json'),
    JSON.stringify(
      { browser: browser.version(), results, resizeSync: 'script and series passed' },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS: ${results.length} surface/viewport/JS combinations; keyboard region scrolling; resize sync; screenshots in ${output}`,
  );
} finally {
  await browser.close();
  server.close();
}
