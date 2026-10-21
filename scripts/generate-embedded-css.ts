/**
 * Regenerates `src/web/styles/embedded.ts` from the authored stylesheets.
 *
 * `tests/web/embedded.test.ts` re-renders the module on every run and fails if
 * the two disagree, so this script is the only supported way to change the
 * embedded bundle:
 *
 *   npx tsx scripts/generate-embedded-css.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { renderEmbeddedModule, type StyleSource } from '../src/web/styles/embed.js';

const SOURCES: readonly { file: string; exportName: string }[] = [
  { file: 'tokens.css', exportName: 'tokensCss' },
  { file: 'base.css', exportName: 'baseCss' },
  { file: 'shell.css', exportName: 'shellCss' },
  { file: 'auth.css', exportName: 'authCss' },
  { file: 'series.css', exportName: 'seriesCss' },
  { file: 'workspace.css', exportName: 'workspaceCss' },
  { file: 'narration.css', exportName: 'narrationCss' },
  { file: 'quality.css', exportName: 'qualityCss' },
  { file: 'operations.css', exportName: 'operationsCss' },
];

const styles: StyleSource[] = SOURCES.map((source) => ({
  file: source.file,
  exportName: source.exportName,
  content: readFileSync(new URL('../src/web/styles/' + source.file, import.meta.url), 'utf8'),
}));

const target = new URL('../src/web/styles/embedded.ts', import.meta.url);
writeFileSync(target, renderEmbeddedModule(styles));
console.log('wrote src/web/styles/embedded.ts from ' + SOURCES.length + ' stylesheets');
