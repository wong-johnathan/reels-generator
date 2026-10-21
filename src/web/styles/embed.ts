/**
 * Generates `embedded.ts` from the authored stylesheets.
 *
 * The web image copies only TypeScript output, so the runtime cannot read a
 * `.css` file from disk. The generated module carries the identical bytes and
 * tests/web/embedded.test.ts re-renders it from the sources on every run —
 * editing a stylesheet without regenerating it fails the build instead of
 * shipping a stale token layer.
 */

export interface StyleSource {
  readonly file: string;
  readonly exportName: string;
  readonly content: string;
}

const HEADER = [
  '// GENERATED FILE — do not edit by hand.',
  '//',
  '// Source of truth: src/web/styles/tokens.css, base.css and shell.css',
  '// (UI_SPEC §2, §4, §7). Regenerate with renderEmbeddedModule() in embed.ts;',
  '// tests/web/embedded.test.ts fails the build if this file and the',
  '// stylesheets disagree.',
  '//',
  '// The web image copies only TypeScript output, so the runtime CSS is imported',
  '// from this module instead of being read from disk.',
  '',
].join('\n');

/** Backticks and interpolation markers must not terminate the template literal. */
export function escapeForTemplateLiteral(value: string): string {
  return value.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

export function renderEmbeddedModule(sources: readonly StyleSource[]): string {
  const blocks = sources.map(
    (source) =>
      '/** ' +
      source.file +
      ' */\n' +
      'export const ' +
      source.exportName +
      ' = String.raw`' +
      escapeForTemplateLiteral(source.content) +
      '`;\n',
  );
  const names = sources.map((source) => source.exportName);
  const bundle = 'export const APP_CSS = [' + names.join(', ') + "].join('\\n');\n";
  return HEADER + blocks.join('\n') + bundle;
}
