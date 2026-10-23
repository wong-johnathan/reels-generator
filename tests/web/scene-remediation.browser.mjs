/* global process, document, getComputedStyle, console */
/** Local component/full-shell regression, not an authenticated application server.
 * npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/web/scene-remediation.browser.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL, URL } from 'node:url';

import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderSceneDetail } from '../../dist/src/web/render/sceneDetail.js';
import { renderStoryboard } from '../../dist/src/web/render/storyboard.js';
import { renderSceneGrid } from '../../dist/src/web/render/sceneGrid.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = new URL('../../evidence/remed-scene/', import.meta.url);
mkdirSync(output, { recursive: true });
const detail = FIXTURES['video.get'];
const storyboard = { ...FIXTURES['storyboard.get'], approved: false, approved_at: null };
const scene = storyboard.scenes[6];
const states = {
  wired: { wired: true, blockedReason: null },
  unwired: { wired: false, blockedReason: null },
  blocked: { wired: true, blockedReason: 'Image stage is running.' },
};
function shell(content, grid = false) {
  return renderShell(
    buildShellModel({
      title: 'Scene remediation',
      nav: 'series',
      overview: FIXTURES['overview.get'],
      session: FIXTURES['auth.session'],
      content,
      assets: { extraScripts: grid ? ['/assets/client/sceneGrid.js'] : [] },
    }),
  );
}
const pages = Object.fromEntries(
  Object.entries(states).map(([state, replace]) => [
    `/videos/${detail.id}/scenes/${scene.scene_no}?state=${state}`,
    shell(renderSceneDetail({ detail, scene, total: 17, replace })),
  ]),
);
pages['/storyboard'] = shell(renderStoryboard({ detail, storyboard }));
pages['/grid'] = shell(renderSceneGrid({ detail, storyboard, release: { wired: true } }), true);
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
        /* non-fixture asset */
      }
    }
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('content-type', 'text/html');
  res.end(pages[req.url] ?? 'Not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const results = [];
const monitoring = 'Approvals need a screen 1024 px or wider. This view is monitoring only.';
async function target(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box && box.width >= 24 && box.height >= 24, `${selector}: ${JSON.stringify(box)}`);
  return box;
}
async function exposed(page, selector, visible) {
  assert.equal(await page.locator(selector).isVisible(), visible, selector);
  if (!visible) {
    assert.equal(
      await page.locator(selector).evaluate((el) => getComputedStyle(el).display),
      'none',
    );
  }
}
async function axAndTab(page, hiddenSelector, hidden, axName) {
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  const found = tree.nodes.some((node) => !node.ignored && node.name?.value?.includes(axName));
  assert.equal(found, !hidden, `AX ${axName}`);
  await cdp.detach();
  // Traverse the real tab sequence twice, rather than assuming tabindex implies visibility.
  const count = await page.locator('a, button, textarea, input, [tabindex]').count();
  let reached = false;
  for (let i = 0; i < count * 2; i++) {
    await page.keyboard.press('Tab');
    reached ||= await page.evaluate(
      (selector) => !!document.activeElement?.matches(selector),
      hiddenSelector,
    );
  }
  if (hidden) assert.equal(reached, false, `tab exposed ${hiddenSelector}`);
}
try {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    for (const width of [1440, 1024, 768, 767, 480, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const state of Object.keys(states)) {
        await page.goto(origin + `/videos/${detail.id}/scenes/${scene.scene_no}?state=${state}`);
        await exposed(page, '.scene-replace', width >= 1024);
        await exposed(page, '.scene-replace-width-note', width >= 768 && width < 1024);
        await exposed(page, '.scene-replace-monitoring-note', width < 768);
        if (width < 1024) {
          const note = page.locator(
            width < 768 ? '.scene-replace-monitoring-note' : '.scene-replace-width-note',
          );
          assert.equal(
            await note.textContent(),
            width < 768 ? monitoring : 'Open at 1024 px or wider to replace a scene image.',
          );
        }
        await axAndTab(
          page,
          '.scene-replace textarea, .scene-replace button',
          width < 1024,
          'Image prompt for this scene',
        );
        const back = await target(page, '.scene-detail-back a');
        if (state === 'wired' && [1440, 768, 390, 320].includes(width)) {
          await page.screenshot({
            path: new URL(`scene-${width}-js${javaScriptEnabled}.png`, output).pathname,
            fullPage: true,
          });
        }
        results.push({
          surface: 'direct-scene',
          state,
          width,
          javaScriptEnabled,
          replaceVisible: width >= 1024,
          back,
        });
      }
      await page.goto(origin + '/storyboard');
      await exposed(page, '.storyboard-approve', width >= 768);
      await exposed(page, '.storyboard-monitoring-note', width < 768);
      await axAndTab(page, '[data-approve-storyboard]', width < 768, 'Approve storyboard');
      if (width >= 768) {
        const approve = await page.locator('[data-approve-storyboard]').boundingBox();
        assert.ok(approve.width >= 44 && approve.height >= 44);
      }
      const link = await target(page, '.storyboard-scene');
      results.push({
        surface: 'storyboard',
        width,
        javaScriptEnabled,
        approveVisible: width >= 768,
        link,
      });
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: new URL(`storyboard-${width}-js${javaScriptEnabled}.png`, output).pathname,
          fullPage: true,
        });
      await page.goto(origin + '/grid');
      if (width >= 1024) {
        const columns = await page
          .locator('.scene-tiles')
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
        assert.equal(columns, width === 1440 ? 6 : 4);
        const first = await page.locator('[data-scene-tile]').first().boundingBox();
        const below = await page.locator('[data-scene-tile]').nth(columns).boundingBox();
        assert.ok(Math.abs(first.x - below.x) < 1 && below.y > first.y, 'visual row geometry');
        if (javaScriptEnabled) {
          await page.waitForFunction(
            () => document.querySelector('[data-scene-tile]')?.getAttribute('tabindex') === '0',
          );
          await page.locator('[data-scene-tile]').first().focus();
          await page
            .locator('[data-scene-grid]')
            .evaluate((el) => el.setAttribute('data-columns', '99'));
          await page.keyboard.press('ArrowDown');
          assert.equal(
            await page.locator('[data-scene-tile]:focus').getAttribute('data-scene-no'),
            columns === 6 ? 'S07' : 'S05',
          );
          await page.keyboard.press('ArrowUp');
          assert.equal(
            await page.locator('[data-scene-tile]:focus').getAttribute('data-scene-no'),
            'S01',
          );
        }
        results.push({ surface: 'grid', width, javaScriptEnabled, columns });
      }
    }
    if (javaScriptEnabled) {
      await page.goto(origin + '/grid');
      for (const [width, expected] of [
        [1024, 'S05'],
        [1440, 'S07'],
        [1024, 'S05'],
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('[data-scene-tile]').first().focus();
        await page.keyboard.press('ArrowDown');
        assert.equal(
          await page.locator('[data-scene-tile]:focus').getAttribute('data-scene-no'),
          expected,
        );
        results.push({ surface: 'resize', width, expected });
      }
    }
    await context.close();
  }
  writeFileSync(new URL('browser-results.json', output), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASS: ${results.length} browser cases, JS on/off, real tab/AX, live resize`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
