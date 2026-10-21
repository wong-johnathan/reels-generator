import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderEmbeddedModule } from '../../src/web/styles/embed.js';
import { APP_CSS, authCss, baseCss, shellCss, tokensCss } from '../../src/web/styles/embedded.js';

/**
 * The runtime serves CSS from a generated module (the image build copies only
 * TypeScript output). This guard keeps that module byte-identical to the
 * authored stylesheets, so the design tokens cannot quietly diverge from what
 * production ships.
 */

const read = (name: string): string =>
  readFileSync(new URL('../../src/web/styles/' + name, import.meta.url), 'utf8');

describe('embedded stylesheets', () => {
  it('mirrors tokens.css exactly', () => {
    expect(tokensCss).toBe(read('tokens.css'));
  });

  it('mirrors base.css exactly', () => {
    expect(baseCss).toBe(read('base.css'));
  });

  it('mirrors shell.css exactly', () => {
    expect(shellCss).toBe(read('shell.css'));
  });

  it('mirrors auth.css exactly', () => {
    expect(authCss).toBe(read('auth.css'));
  });

  it('is exactly what the generator renders from the four sources', () => {
    const moduleText = readFileSync(
      new URL('../../src/web/styles/embedded.ts', import.meta.url),
      'utf8',
    );
    const expected = renderEmbeddedModule([
      { file: 'tokens.css', exportName: 'tokensCss', content: read('tokens.css') },
      { file: 'base.css', exportName: 'baseCss', content: read('base.css') },
      { file: 'shell.css', exportName: 'shellCss', content: read('shell.css') },
      { file: 'auth.css', exportName: 'authCss', content: read('auth.css') },
    ]);
    expect(moduleText).toBe(expected);
  });

  it('bundles the layers in cascade order: tokens, base, shell, auth', () => {
    expect(APP_CSS).toBe([tokensCss, baseCss, shellCss, authCss].join('\n'));
    expect(APP_CSS.indexOf('--surface-app')).toBeLessThan(APP_CSS.indexOf('box-sizing'));
    expect(APP_CSS.indexOf('box-sizing')).toBeLessThan(APP_CSS.indexOf('.status-strip'));
    expect(APP_CSS.indexOf('.status-strip')).toBeLessThan(APP_CSS.indexOf('.login-card'));
  });
});
