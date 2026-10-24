/* global process, document, getComputedStyle, console */
/** Local component/full-shell regression, not an authenticated application server.
 * npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/web/scene-remediation.browser.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

import { FIXTURES } from '../../dist/contract/mock/fixtures.js';
import { renderSceneDetail } from '../../dist/src/web/render/sceneDetail.js';
import { renderStoryboard } from '../../dist/src/web/render/storyboard.js';
import { renderSceneGrid } from '../../dist/src/web/render/sceneGrid.js';
import { buildShellModel, renderShell } from '../../dist/src/web/render/shell.js';
import { APP_CSS } from '../../dist/src/web/styles/embedded.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = join(resolve(process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'), 'scene');
mkdirSync(output, { recursive: true });
const detail = FIXTURES['video.get'];
const storyboard = { ...FIXTURES['storyboard.get'], approved: false, approved_at: null };
const scene = storyboard.scenes.find((scene) => scene.asset !== null);
assert.ok(scene, 'stored-image replacement fixture');
const storyboardStates = {
  pending: { detail, storyboard },
  approved: { detail, storyboard: { ...storyboard, approved: true } },
  blocked: {
    detail: {
      ...detail,
      stages: detail.stages.map((row) =>
        row.stage === 'SB'
          ? { ...row, state: 'blocked', blocked_reason: 'Script approval required' }
          : row,
      ),
    },
    storyboard: null,
  },
  empty: { detail, storyboard: null },
};
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
for (const [state, input] of Object.entries(storyboardStates))
  pages['/storyboard?state=' + state] = shell(renderStoryboard(input));
pages['/grid'] = shell(renderSceneGrid({ detail, storyboard, release: { wired: true } }), true);
pages['/grid-checkpoint'] = shell(
  renderSceneGrid({
    detail: {
      ...detail,
      stages: detail.stages.map((row) =>
        row.stage === 'IM' ? { ...row, blocked_reason: null } : row,
      ),
    },
    storyboard: {
      ...storyboard,
      first_three_reviewed: false,
      scenes: storyboard.scenes.map((scene, i) =>
        i < 3 ? { ...scene, state: 'done' } : { ...scene, state: 'not_run', asset: null },
      ),
    },
    release: { wired: true },
  }),
  true,
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
const primaryFailures = [];
const monitoring = 'Approvals need a screen 1024 px or wider. This view is monitoring only.';
async function targets(page, selector, minimum = 24) {
  const boxes = [];
  for (const item of await page.locator(selector).all()) {
    const box = await item.boundingBox();
    assert.ok(
      box && box.width >= minimum && box.height >= minimum,
      `${selector}: ${JSON.stringify(box)}`,
    );
    boxes.push(box);
  }
  return boxes;
}
async function primaryAudit(page, root) {
  // Settle the bottom-sticky selection bar at its natural end position before
  // measuring neighbors; otherwise offscreen tiles behind the overlay are
  // incorrectly treated as adjacent controls.
  await page.locator(root).evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const audit = await page.locator(root).evaluate((root) => {
    const visible = (el) =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const controls = [
      ...root.querySelectorAll('a[href], button, textarea, input:not([type="hidden"]), summary'),
    ].filter(visible);
    return controls
      .filter((el) => el.matches('.btn-primary, [data-selection-replace], [data-pager-step]'))
      .map((el) => {
        const box = el.getBoundingClientRect();
        const neighbors = controls
          .filter((other) => other !== el)
          .map((other) => {
            const b = other.getBoundingClientRect();
            const dx = Math.max(0, b.left - box.right, box.left - b.right);
            const dy = Math.max(0, b.top - box.bottom, box.top - b.bottom);
            return { name: other.textContent?.trim().slice(0, 60), gap: Math.hypot(dx, dy) };
          });
        return { name: el.textContent?.trim(), width: box.width, height: box.height, neighbors };
      });
  });
  for (const item of audit) {
    if (item.width < 44 || item.height < 44)
      primaryFailures.push({
        url: page.url(),
        viewport: page.viewportSize(),
        item,
        failure: '44px target',
      });
    for (const neighbor of item.neighbors)
      if (neighbor.gap < 7.99)
        primaryFailures.push({
          url: page.url(),
          viewport: page.viewportSize(),
          item: item.name,
          neighbor,
          failure: '8px separation',
        });
  }
  return audit;
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
async function axAndTab(page, hiddenSelector, hidden, axName, expectedDisabled = false) {
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  const found = tree.nodes.some((node) => !node.ignored && node.name?.value?.includes(axName));
  assert.equal(found, !hidden, `AX ${axName}`);
  const root = await cdp.send('DOM.getDocument');
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
    nodeId: root.root.nodeId,
    selector: hiddenSelector,
  });
  const controls = await page.locator(hiddenSelector).evaluateAll((elements) =>
    elements.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      id: el.id,
      name: el.getAttribute('name'),
      text: el.textContent?.trim(),
      disabled: el.matches(':disabled'),
      hidden: el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden',
      tabIndex: el.tabIndex,
    })),
  );
  for (const control of controls) {
    const { node } = await cdp.send('DOM.describeNode', { nodeId: nodeIds[control.index] });
    const ax = tree.nodes.find((item) => item.backendDOMNodeId === node.backendNodeId);
    control.axExposed = !!ax && !ax.ignored;
    control.axDisabled =
      ax?.properties?.find((property) => property.name === 'disabled')?.value?.value ?? false;
    assert.equal(control.hidden, hidden, `visibility ${hiddenSelector}[${control.index}]`);
    assert.equal(
      control.disabled,
      expectedDisabled,
      `native disabled ${hiddenSelector}[${control.index}]`,
    );
    assert.equal(control.axExposed, !hidden, `individual AX ${hiddenSelector}[${control.index}]`);
    if (!hidden)
      assert.equal(
        control.axDisabled,
        expectedDisabled,
        `AX disabled ${hiddenSelector}[${control.index}]`,
      );
  }
  await cdp.detach();
  // Traverse the real tab sequence twice, rather than assuming tabindex implies visibility.
  const count = await page.locator('a, button, textarea, input, [tabindex]').count();
  let reached = false;
  const reachedIndices = new Set();
  for (let i = 0; i < count * 2; i++) {
    await page.keyboard.press('Tab');
    reached ||= await page.evaluate(
      (selector) => !!document.activeElement?.matches(selector),
      hiddenSelector,
    );
    for (const index of await page
      .locator(hiddenSelector)
      .evaluateAll((elements) =>
        elements.flatMap((el, index) => (el === document.activeElement ? [index] : [])),
      ))
      reachedIndices.add(index);
  }
  if (hidden) assert.equal(reached, false, `tab exposed ${hiddenSelector}`);
  for (const control of controls) {
    control.tabReached = reachedIndices.has(control.index);
    control.expectedTabReach = !control.hidden && !control.disabled;
    assert.equal(
      control.tabReached,
      control.expectedTabReach,
      `individual real Tab ${hiddenSelector}[${control.index}] ${control.tag}`,
    );
  }
  return {
    selector: hiddenSelector,
    present: controls.length > 0,
    expectedHidden: hidden,
    expectedDisabled,
    axNameExposed: found,
    reached,
    controls,
  };
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
        const keyboard = await axAndTab(
          page,
          '.scene-replace textarea, .scene-replace button',
          width < 1024,
          'Image prompt for this scene',
          state !== 'wired',
        );
        assert.equal(keyboard.controls.length, 2, 'textarea and replace button audited separately');
        const back = await targets(page, '.scene-detail-back a');
        assert.equal(await page.locator('[data-replace]').count(), 1);
        assert.equal(await page.locator('[data-replace]').isDisabled(), state !== 'wired');
        const primary = await primaryAudit(page, '.scene-detail');
        assert.equal(primary.length, width >= 1024 ? 1 : 0);
        if (state === 'wired' && [1440, 768, 390, 320].includes(width)) {
          await page.screenshot({
            path: join(output, `scene-${width}-js${javaScriptEnabled}.png`),
            fullPage: true,
          });
        }
        results.push({
          surface: 'direct-scene',
          state,
          width,
          javaScriptEnabled,
          replaceVisible: width >= 1024,
          keyboard,
          back,
          primary,
        });
      }
      for (const state of Object.keys(storyboardStates)) {
        await page.goto(origin + '/storyboard?state=' + state);
        const pending = state === 'pending';
        assert.equal(await page.locator('[data-approve-storyboard]').count(), pending ? 1 : 0);
        if (pending) {
          await exposed(page, '.storyboard-approve', width >= 768);
          await exposed(page, '.storyboard-monitoring-note', width < 768);
        }
        const keyboard = await axAndTab(
          page,
          '[data-approve-storyboard]',
          !pending || width < 768,
          'Approve storyboard',
        );
        assert.equal(keyboard.controls.length, pending ? 1 : 0, 'approval audit cardinality');
        const links = await targets(page, '.storyboard-scene');
        assert.equal(links.length, pending || state === 'approved' ? storyboard.scenes.length : 0);
        if (state === 'approved')
          assert.equal(await page.locator('[data-storyboard-approved]').isVisible(), true);
        if (state === 'blocked')
          assert.match(
            await page.locator('.storyboard-reason').textContent(),
            /Script approval required/,
          );
        const primary = await primaryAudit(page, '.storyboard');
        assert.equal(primary.length, pending && width >= 768 ? 1 : 0);
        results.push({
          surface: 'storyboard',
          state,
          width,
          javaScriptEnabled,
          approveVisible: pending && width >= 768,
          keyboard,
          links,
          primary,
        });
        if (pending && (width === 1440 || width === 390))
          await page.screenshot({
            path: join(output, `storyboard-${width}-js${javaScriptEnabled}.png`),
            fullPage: true,
          });
      }
      await page.goto(origin + '/grid');
      if (width >= 768 && width < 1024 && javaScriptEnabled) {
        const prev = page.locator('[data-pager-step="-1"]');
        const next = page.locator('[data-pager-step="1"]');
        await next.waitFor({ state: 'visible' });
        const primary = await primaryAudit(page, '.scene-grid');
        assert.equal(primary.length, 2);
        const [prevBox] = await targets(page, '[data-pager-step="-1"]', 44);
        const [nextBox] = await targets(page, '[data-pager-step="1"]', 44);
        assert.ok(nextBox.x - prevBox.x - prevBox.width >= 8);
        await page.locator('[data-scene-pager]').first().focus();
        await page.keyboard.press('Tab');
        assert.equal(await prev.evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await next.evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-pager-readout]').textContent(), 'S02 of 17');
        assert.equal(await next.evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Space');
        assert.equal(await page.locator('[data-pager-readout]').textContent(), 'S01 of 17');
        assert.equal(await prev.evaluate((el) => el === document.activeElement), true);
        await page.locator('[data-scene-pager]').first().focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(
          await page.locator('[data-scene-pager]:focus').getAttribute('data-scene-label'),
          'S02',
        );
        await page.keyboard.press('ArrowLeft');
        assert.equal(
          await page.locator('[data-scene-pager]:focus').getAttribute('data-scene-label'),
          'S01',
        );
        assert.equal(await page.locator('[data-pager-item]:not([hidden])').count(), 1);
        results.push({ surface: 'pager-keyboard', width, javaScriptEnabled, primary });
      } else {
        assert.equal(await page.locator('[data-pager-controls]').isVisible(), false);
      }
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
        const primary = await primaryAudit(page, '.scene-grid');
        assert.equal(primary.length, 1);
        results.push({ surface: 'grid', width, javaScriptEnabled, columns, primary });
      }
      await page.goto(origin + '/grid-checkpoint');
      assert.equal(await page.locator('[data-release]').count(), 1);
      const primary = await primaryAudit(page, '.scene-grid');
      assert.equal(await page.locator('[data-release]').isVisible(), width >= 768);
      results.push({ surface: 'checkpoint-primary', width, javaScriptEnabled, primary });
    }
    if (javaScriptEnabled) {
      await page.setViewportSize({ width: 768, height: 1000 });
      await page.goto(origin + '/grid');
      await page.locator('[data-pager-step="1"]').focus();
      await page.keyboard.press('ArrowRight');
      for (const [width, selector] of [
        [1024, '[data-scene-tile][data-scene-no="S02"]'],
        [768, '[data-scene-pager][data-scene-label="S02"]'],
        [390, '[data-scene-list][data-scene-label="S02"]'],
        [1440, '[data-scene-tile][data-scene-no="S02"]'],
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForFunction(
          (selector) => document.activeElement?.matches(selector),
          selector,
        );
        assert.equal(
          await page.locator(selector).evaluate((el) => el === document.activeElement),
          true,
        );
        assert.equal(await page.locator(selector).isVisible(), true);
        results.push({ surface: 'logical-resize-focus', width, selector });
      }
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
    // Seed remembered scene focus, then move outside before repeated band changes.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + '/grid');
    if (javaScriptEnabled) {
      await page.waitForFunction(
        () => document.querySelector('[data-scene-tile]')?.getAttribute('tabindex') === '0',
      );
    }
    await page.locator('[data-scene-tile]').nth(1).focus();
    const outside = await page.locator('.skip-link').elementHandle();
    await outside.focus();
    for (const width of [768, 390, 1440, 1024, 767, 320, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      // Allow resize/media-query delivery and delayed effects to settle. JS-off
      // verifies native safety only, not execution of enhancement callbacks.
      await page.waitForTimeout(150);
      const sameIdentity = await outside.evaluate(
        (el) => el.isConnected && el === document.activeElement,
      );
      assert.equal(sameIdentity, true, `outside focus at ${width}, JS ${javaScriptEnabled}`);
      assert.equal(await outside.isVisible(), true);
      assert.equal(
        await page.locator('[data-pager-controls]').isVisible(),
        javaScriptEnabled && width >= 768 && width < 1024,
      );
      results.push({
        surface: 'outside-resize-focus',
        width,
        javaScriptEnabled,
        selector: '.skip-link',
        sameIdentity,
        enhancement: javaScriptEnabled,
      });
    }
    await outside.dispose();
    await context.close();
  }
  writeFileSync(join(output, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(
    join(output, 'primary-failures.json'),
    JSON.stringify(primaryFailures, null, 2) + '\n',
  );
  assert.deepEqual(primaryFailures, [], 'primary target/neighbor audit');
  console.log(`PASS: ${results.length} browser cases, JS on/off, real tab/AX, live resize`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
