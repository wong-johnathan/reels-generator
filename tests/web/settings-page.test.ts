import { describe, expect, it } from 'vitest';

import { HealthReportSchema, ProviderSettingsViewSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { providerRows, type HealthReport } from '../../src/web/health/model.js';
import { renderSettings } from '../../src/web/render/settings.js';
import { KEY_VALUES_LINE, READ_ONLY_LINE, settingsModel } from '../../src/web/settings/model.js';
import { byId, byTag, findAll, parseHtml, textOf } from './helpers/html.js';

/**
 * S-21 Settings — US-004, US-012, R-008-3, R-015-5 (C-19): read-only view of
 * key presence and qualification. No key value is ever rendered, and an
 * absent key names the exact variable and the restart step.
 */

const report: HealthReport = HealthReportSchema.parse(FIXTURES['health.report']);
const settings = ProviderSettingsViewSchema.parse(FIXTURES['settings.providers']);

function render(providers: typeof settings = settings, rows = providerRows(providers.providers)) {
  const model = settingsModel({ providers, rows });
  return { html: renderSettings(model), root: parseHtml(renderSettings(model)) };
}

describe('S-21 read-only settings', () => {
  it('marks the page read-only and says where changes happen', () => {
    const { root } = render();
    expect(byId(root, 'settings')!.attrs['data-read-only']).toBe('true');
    expect(textOf(byId(root, 'settings-readonly')!)).toBe(READ_ONLY_LINE);
    expect(textOf(byId(root, 'settings-readonly')!)).toContain('.env');
  });

  it('never renders an input or a secret value', () => {
    const { root, html } = render();
    expect(byTag(root, 'input')).toHaveLength(0);
    expect(byTag(root, 'form')).toHaveLength(0);
    expect(textOf(byId(root, 'settings-key-values')!)).toBe(KEY_VALUES_LINE);
    expect(html).not.toContain('sk-');
  });

  it('summarises all keys present and the qualification count', () => {
    const { root } = render();
    expect(textOf(byId(root, 'settings-summary')!)).toBe('3 of 3 keys present.');
    expect(textOf(byId(root, 'settings-qualification')!)).toBe(
      '2 of 3 providers passed qualification; NOT RUN is not a pass.',
    );
  });

  it('lists each provider with presence, variable name, qualification and idempotency', () => {
    const { root } = render();
    const rows = findAll(
      root,
      (node) => node.tag === 'tr' && node.attrs['data-qualified'] !== undefined,
    );
    expect(rows).toHaveLength(3);
    const first = textOf(rows[0]!);
    expect(first).toContain('Text and research');
    expect(first).toContain('present');
    expect(first).toContain('DEEPSEEK_API_KEY');
    expect(first).toContain('unprotected');
    expect(first).toContain('PASS 2026-10-20T09:00:00Z');
    const third = textOf(rows[2]!);
    expect(third).toContain('NOT RUN');
    expect(third).toContain('qualification pending');
  });

  it('uses a structural key word, not colour alone', () => {
    const { root } = render();
    const words = findAll(
      root,
      (node) => node.tag === 'span' && node.attrs['data-key'] !== undefined,
    );
    expect(words.map((node) => node.attrs['data-key'])).toEqual(['present', 'present', 'present']);
  });
});

describe('S-21 absent keys', () => {
  const oneAbsent = {
    ...settings,
    providers: settings.providers.map((provider) =>
      provider.provider === 'elevenlabs'
        ? { ...provider, key_present: false, qualified: false, qualified_at: null }
        : provider,
    ),
  };

  it('names the exact missing variable and the single restart step', () => {
    const { root } = render(oneAbsent as typeof settings);
    expect(textOf(byId(root, 'settings-summary')!)).toBe(
      '2 of 3 keys present. Absent: ELEVENLABS_API_KEY. Set it in .env and restart.',
    );
  });

  it('switches to the plural when more than one key is missing', () => {
    const none = {
      ...settings,
      providers: settings.providers.map((provider) => ({
        ...provider,
        key_present: false,
        qualified: false,
        qualified_at: null,
      })),
    };
    const { root } = render(none as typeof settings);
    expect(textOf(byId(root, 'settings-summary')!)).toBe(
      '0 of 3 keys present. Absent: DEEPSEEK_API_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY. Set them in .env and restart.',
    );
    const words = findAll(
      root,
      (node) => node.tag === 'span' && node.attrs['data-key'] !== undefined,
    );
    expect(words.map((node) => node.attrs['data-key'])).toEqual(['absent', 'absent', 'absent']);
  });

  it('reports a failed qualification as NOT RUN, never as a pass', () => {
    const failed = {
      ...settings,
      providers: report.providers.map((provider) => ({
        ...provider,
        qualified: false,
        qualified_at: null,
      })),
    };
    const { root } = render(failed as typeof settings);
    expect(textOf(byId(root, 'settings-qualification')!)).toBe(
      '0 of 3 providers passed qualification; NOT RUN is not a pass.',
    );
  });
});
