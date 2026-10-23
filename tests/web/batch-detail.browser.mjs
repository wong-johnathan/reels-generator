/* global process, document, window, getComputedStyle, console */
/** Local-only failed-batch regression. Run npm run build first.
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node tests/web/batch-detail.browser.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderBatchDetail } from '../../dist/src/web/render/batchDetail.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = new URL('../../evidence/remed-batch/', import.meta.url);
mkdirSync(output, { recursive: true });
const now = new Date('2026-10-21T20:00:00Z');
const content = renderBatchDetail({
  now,
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
          attemptStatus: 'unknown_charge',
          runStatus: 'timed_out',
          chargeStatus: 'unknown',
          errorClass: 'transient',
          message: 'Image provider timed out before returning a response.',
          at: now.toISOString(),
        },
      },
    ],
  },
});
const html = renderShell(
  buildShellModel({
    title: 'Batch detail',
    nav: 'series',
    overview: FIXTURES['overview.get'],
    session: FIXTURES['auth.session'],
    content,
  }),
);
const server = createServer((req, res) => {
  if (req.url === '/assets/app.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(APP_CSS);
  }
  if (req.url?.startsWith('/assets/')) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('content-type', 'text/html');
  res.end(html);
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
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${server.address().port}/batches/b1`);
      const metrics = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { width: r.width, height: r.height };
        };
        const visible = (selector) => document.querySelector(selector).getClientRects().length > 0;
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
        'transient',
        'Attempts used: 2',
        'Topic retained; script retained; 3 scene records retained.',
        'unknown charge',
        'Retry requeues only failed jobs',
        'Next action:',
      ])
        assert(metrics.detail.includes(text));
      const session = await context.newCDPSession(page);
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      const retryInAX = nodes.some(
        (n) =>
          !n.ignored && n.role?.value === 'button' && n.name?.value === 'Regenerate failed videos',
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
        await page.locator('.batch-subject a').evaluate((el) => getComputedStyle(el).outlineStyle),
        'none',
      );
      results.push({ javaScriptEnabled, width, ...metrics, retryInAX, tabs });
      if ([1440, 768, 390, 320].includes(width))
        await page.screenshot({
          path: new URL(`batch-${width}-js${javaScriptEnabled}.png`, output).pathname,
          fullPage: true,
        });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  writeFileSync(
    new URL('browser-results.json', output),
    JSON.stringify({ browser: browser.version(), results }, null, 2) + '\n',
  );
  console.log(
    `PASS: ${results.length} failed-batch viewport/JS combinations; computed visibility, targets, spacing, AX and keyboard tab checks`,
  );
} finally {
  await browser.close();
  server.close();
}
