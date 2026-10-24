/* global process, document, window, getComputedStyle, console, structuredClone */
/** Local-only failed-batch regression. Run npm run build first.
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node tests/web/batch-detail.browser.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderBatchDetail } from '../../dist/src/web/render/batchDetail.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = join(resolve(process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'), 'batch');
mkdirSync(output, { recursive: true });
const now = new Date('2026-10-21T20:00:00Z');
const variants = [
  ...['pending', null, 'unknown'].map((chargeStatus) => ({
    name: `timeout-${chargeStatus}`,
    chargeStatus,
    attemptStatus: 'unknown_charge',
    runStatus: 'timed_out',
    errorClass: 'transient',
    message: 'Provider request timed out.',
    expected: true,
  })),
  ...['billed', 'unbilled'].map((chargeStatus) => ({
    name: `failed-${chargeStatus}`,
    chargeStatus,
    attemptStatus: 'failed',
    runStatus: 'failed',
    errorClass: 'non_retryable',
    message: 'Provider rejected the request.',
    expected: false,
  })),
];
// Retain the exact 17-case structured matrix from QA_EVIDENCE.zip/qa-extra.mjs.
for (const chargeStatus of ['pending', null, 'billed', 'unbilled']) {
  for (const [signal, attemptStatus, runStatus] of [
    ['attempt-only', 'unknown_charge', 'failed'],
    ['run-only', 'failed', 'timed_out'],
    ['both', 'unknown_charge', 'timed_out'],
    ['no-signal', 'failed', 'failed'],
  ]) {
    variants.push({
      name: `${signal}-${chargeStatus}`,
      chargeStatus,
      attemptStatus,
      runStatus,
      errorClass: 'transient',
      message: 'Provider request timed out.',
      expected: signal !== 'no-signal',
    });
  }
}
for (const [signal, attemptStatus, runStatus] of [
  ['charge-only', 'failed', 'failed'],
  ['charge-and-attempt', 'unknown_charge', 'failed'],
  ['charge-and-run', 'failed', 'timed_out'],
]) {
  variants.push({
    name: signal,
    chargeStatus: 'unknown',
    attemptStatus,
    runStatus,
    errorClass: 'transient',
    message: 'Provider rejected the request.',
    expected: true,
  });
}
function objectGraph(value, path = '$') {
  if (value === null || typeof value !== 'object') return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([key, child]) => objectGraph(child, `${path}.${key}`)),
  ];
}
const inputs = [];
function renderFrozen(input, render, label) {
  const before = structuredClone(input);
  const graph = objectGraph(input);
  for (const [, value] of graph) Object.freeze(value);
  assert(
    graph.every(([, value]) => Object.isFrozen(value)),
    `${label}: deeply frozen`,
  );
  const html = render(input);
  assert.deepEqual(input, before, `${label}: source facts unchanged`);
  const after = objectGraph(input);
  assert.equal(after.length, graph.length, `${label}: graph size`);
  graph.forEach(([path, value], index) => {
    assert.equal(after[index][0], path, `${label}: object path`);
    assert.strictEqual(after[index][1], value, `${label}: ${path} identity`);
  });
  inputs.push({ label, frozenObjects: graph.length, deepEqual: true, identity: true });
  return html;
}
function renderVariant(variant) {
  const content = renderFrozen(
    {
      now: new Date(now),
      batch: {
        id: 'b1',
        ordinal: 2,
        status: 'NEEDS_ATTENTION',
        targetCount: 1,
        createdAt: now.toISOString(),
        seriesId: 's1',
        seriesName: 'Retained content series',
        videos: [
          {
            projectId: 'p1',
            position: 1,
            status: 'NEEDS_ATTENTION',
            currentStage: 'IM',
            videoAssetId: null,
            sceneCount: 3,
            topic: {
              title: 'A retained topic',
              description: 'Research is still recorded.',
              rationale: null,
            },
            script: {
              revision: 1,
              wordCount: 12,
              estimatedRuntimeS: 8,
              title: 'Retained script',
              script: 'This script was not lost when the image stage timed out.',
              description: null,
              hashtags: [],
            },
            failure: {
              stage: 'IM',
              attemptNo: 2,
              attemptStatus: variant.attemptStatus,
              runStatus: variant.runStatus,
              chargeStatus: variant.chargeStatus,
              errorClass: variant.errorClass,
              message: variant.message,
              at: now.toISOString(),
            },
          },
        ],
      },
    },
    renderBatchDetail,
    `${variant.name}:batch`,
  );
  return renderFrozen(
    structuredClone({
      title: 'Batch detail',
      nav: 'series',
      overview: FIXTURES['overview.get'],
      session: FIXTURES['auth.session'],
      content,
    }),
    (input) => renderShell(buildShellModel(input)),
    `${variant.name}:shell`,
  );
}
const pages = new Map(variants.map((variant) => [variant.name, renderVariant(variant)]));
let scriptResponses = 0;
const server = createServer((req, res) => {
  if (req.url === '/assets/app.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(APP_CSS);
  }
  if (req.url?.startsWith('/assets/')) {
    if (/^\/assets\/[\w/.-]+\.js$/.test(req.url) && !req.url.includes('..')) {
      try {
        const asset = readFileSync(
          new URL(`../../dist/src/web/${req.url.slice(8)}`, import.meta.url),
        );
        res.setHeader('content-type', 'text/javascript');
        scriptResponses++;
        return res.end(asset);
      } catch {
        // Unknown assets remain 404; do not substitute synthetic client code.
      }
    }
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('content-type', 'text/html');
  const variant = variants.find((item) => req.url === `/batches/${item.name}`);
  if (!variant) {
    res.statusCode = 404;
    return res.end();
  }
  res.end(pages.get(variant.name));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const width of [1440, 1024, 768, 767, 480, 390, 320]) {
      for (const variant of variants) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:${server.address().port}/batches/${variant.name}`);
        if (javaScriptEnabled) await page.waitForFunction(() => !!window.reelsAnnounce);
        const metrics = await page.evaluate(() => {
          const rect = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { width: r.width, height: r.height };
          };
          const visible = (selector) =>
            document.querySelector(selector).getClientRects().length > 0;
          const button = document.querySelector('.batch-regenerate button');
          const form = document.querySelector('.batch-regenerate');
          return {
            pageWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            retryVisible: visible('.batch-regenerate button'),
            noteVisible: visible('.batch-width-note'),
            formDisplay: getComputedStyle(form).display,
            retry: rect('.batch-regenerate button'),
            series: rect('.batch-subject a'),
            review: rect('.batch-video-head .btn'),
            gap:
              button.getBoundingClientRect().top -
              form.querySelector('p').getBoundingClientRect().bottom,
            detail: document.querySelector('.batch-failure').textContent,
            unknownParagraphs: Array.from(document.querySelectorAll('.batch-failure p')).filter(
              (el) => el.textContent === 'unknown charge' && el.getClientRects().length > 0,
            ).length,
          };
        });
        assert(metrics.pageWidth <= width, JSON.stringify(metrics));
        assert.equal(metrics.retryVisible, width >= 768);
        assert.equal(metrics.noteVisible, width < 768);
        assert(metrics.series.width >= 24 && metrics.series.height >= 24);
        assert(metrics.review.width >= 44 && metrics.review.height >= 44);
        if (width >= 768) {
          assert(metrics.retry.width >= 44 && metrics.retry.height >= 44);
          assert(metrics.gap >= 8);
        } else assert.equal(metrics.formDisplay, 'none');
        for (const text of [
          'Stage IM failed',
          variant.errorClass,
          'Attempts used: 2',
          'Topic retained; script retained; 3 scene records retained.',

          'Retry requeues only failed jobs',
          'Next action:',
        ])
          assert(metrics.detail.includes(text));
        assert.equal(metrics.unknownParagraphs, variant.expected ? 1 : 0, variant.name);
        assert.equal(metrics.detail.includes('unknown charge'), variant.expected, variant.name);
        const disclosure = page.locator('.batch-failure p').filter({ hasText: /^unknown charge$/ });
        assert.equal(await disclosure.count(), variant.expected ? 1 : 0, variant.name);
        if (variant.expected) assert(await disclosure.isVisible(), variant.name);
        assert(!metrics.detail.includes('unbilled'));
        assert(!metrics.detail.includes('free'));
        const session = await context.newCDPSession(page);
        const { nodes } = await session.send('Accessibility.getFullAXTree');
        const unknownInAX = nodes.some(
          (n) => !n.ignored && n.role?.value === 'StaticText' && n.name?.value === 'unknown charge',
        );
        assert.equal(unknownInAX, variant.expected, `${variant.name}: disclosure AX`);
        const retryInAX = nodes.some(
          (n) =>
            !n.ignored &&
            n.role?.value === 'button' &&
            n.name?.value === 'Regenerate failed videos',
        );
        assert.equal(retryInAX, width >= 768);
        await session.detach();
        await page.locator('.batch-subject a').focus();
        const tabs = [];
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('Tab');
          tabs.push(await page.evaluate(() => document.activeElement?.textContent.trim()));
        }
        assert.equal(tabs.includes('Regenerate failed videos'), width >= 768);
        await page.locator('.batch-subject a').focus();
        assert.notEqual(
          await page
            .locator('.batch-subject a')
            .evaluate((el) => getComputedStyle(el).outlineStyle),
          'none',
        );
        results.push({
          ...variant,
          variant: variant.name,
          javaScriptEnabled,
          width,
          ...metrics,
          retryInAX,
          unknownInAX,
          tabs,
        });
        if ([1440, 768, 390, 320].includes(width))
          await page.screenshot({
            path: join(output, `batch-${variant.name}-${width}-js${javaScriptEnabled}.png`),
            fullPage: true,
          });
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert(scriptResponses > 0, 'JS-on must execute real compiled shell assets');
  assert.equal(results.length, variants.length * 7 * 2);
  writeFileSync(
    join(output, 'browser-results.json'),
    JSON.stringify({ browser: browser.version(), inputs, scriptResponses, results }, null, 2) +
      '\n',
  );
  console.log(
    `PASS: ${results.length} failed-batch viewport/JS combinations; computed visibility, targets, spacing, AX and keyboard tab checks`,
  );
} finally {
  await browser.close();
  server.close();
}
