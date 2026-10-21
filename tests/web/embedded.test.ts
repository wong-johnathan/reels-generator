import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderEmbeddedModule } from '../../src/web/styles/embed.js';
import {
  APP_CSS,
  authCss,
  baseCss,
  qualityCss,
  seriesCss,
  shellCss,
  tokensCss,
  workspaceCss,
} from '../../src/web/styles/embedded.js';

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

  it('mirrors series.css exactly', () => {
    expect(seriesCss).toBe(read('series.css'));
  });

  it('mirrors workspace.css exactly', () => {
    expect(workspaceCss).toBe(read('workspace.css'));
  });

  it('mirrors quality.css exactly', () => {
    expect(qualityCss).toBe(read('quality.css'));
  });

  it('is exactly what the generator renders from the seven sources', () => {
    const moduleText = readFileSync(
      new URL('../../src/web/styles/embedded.ts', import.meta.url),
      'utf8',
    );
    const expected = renderEmbeddedModule([
      { file: 'tokens.css', exportName: 'tokensCss', content: read('tokens.css') },
      { file: 'base.css', exportName: 'baseCss', content: read('base.css') },
      { file: 'shell.css', exportName: 'shellCss', content: read('shell.css') },
      { file: 'auth.css', exportName: 'authCss', content: read('auth.css') },
      { file: 'series.css', exportName: 'seriesCss', content: read('series.css') },
      { file: 'workspace.css', exportName: 'workspaceCss', content: read('workspace.css') },
      { file: 'quality.css', exportName: 'qualityCss', content: read('quality.css') },
    ]);
    expect(moduleText).toBe(expected);
  });

  it('bundles the layers in cascade order: tokens, base, shell, auth, series, workspace, quality', () => {
    expect(APP_CSS).toBe(
      [tokensCss, baseCss, shellCss, authCss, seriesCss, workspaceCss, qualityCss].join('\n'),
    );
    expect(APP_CSS.indexOf('--surface-app')).toBeLessThan(APP_CSS.indexOf('box-sizing'));
    expect(APP_CSS.indexOf('box-sizing')).toBeLessThan(APP_CSS.indexOf('.status-strip'));
    expect(APP_CSS.indexOf('.status-strip')).toBeLessThan(APP_CSS.indexOf('.login-card'));
    expect(APP_CSS.indexOf('.login-card')).toBeLessThan(APP_CSS.indexOf('.series-table'));
    expect(APP_CSS.indexOf('.series-table')).toBeLessThan(APP_CSS.indexOf('.stage-rail'));
    expect(APP_CSS.indexOf('.stage-rail')).toBeLessThan(APP_CSS.indexOf('.attention-row'));
    expect(APP_CSS.indexOf('.attention-row')).toBeLessThan(APP_CSS.indexOf('.quality-grid'));
  });
});
