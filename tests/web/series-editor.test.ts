import { describe, expect, it } from 'vitest';

import { SeriesDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderSeriesEditor } from '../../src/web/render/seriesEditor.js';
import { changedFields, profileToValues } from '../../src/web/series/fields.js';
import type { SeriesEditorModel } from '../../src/web/series/model.js';
import { accessibleTextOf, byTag, hasClass, parseHtml, textOf } from './helpers/html.js';

/**
 * S-04 Series editor (UX_SPEC §2.3/§4 IP-02/A-4/A-5/D-2/D-3, UI_SPEC §4.3,
 * §5 UC-17/UC-19/UC-20, §6.1 S-04 states, §8.1, §9).
 *
 * The editor is complete in the HTML: five labelled field blocks, the IP-02
 * commit panel, the per-field changed marks, the archived read-only state and
 * the IP-09 conflict banner. `client/seriesEditor.ts` only adds the live
 * re-computation of changed fields and the busy label.
 */

const detail = SeriesDetailSchema.parse(FIXTURES['series.get']);
const profileValues = profileToValues(detail.profile);
const initial = { ...profileValues, name: detail.name, slug: detail.slug };
const values = { ...initial };

const base = (overrides: Partial<SeriesEditorModel> = {}): SeriesEditorModel => ({
  mode: 'edit',
  status: detail.status,
  detail,
  values,
  initial,
  changed: [],
  errors: {},
  inFlightBatches: detail.in_flight_batches,
  ...overrides,
});

const edit = (overrides: Partial<SeriesEditorModel> = {}) => {
  const parts = renderSeriesEditor(base(overrides));
  return { ...parts, doc: parseHtml(parts.main), panel: parseHtml(parts.aside), html: parts.main };
};

describe('batch confirmation', () => {
  it('confirms a started batch and links to the Batches page', () => {
    const { html } = edit({ batchedCount: 2 });
    expect(html).toContain('Started 2 videos');
    expect(html).toContain('href="/batches"');
  });

  it('uses the singular for a one-video batch', () => {
    const { html } = edit({ batchedCount: 1 });
    expect(html).toContain('Started 1 video.');
  });

  it('says nothing when no batch was just started', () => {
    const { html } = edit();
    expect(html).not.toContain('Started');
  });
});

const create = (overrides: Partial<SeriesEditorModel> = {}) =>
  renderSeriesEditor(
    base({
      mode: 'create',
      detail: undefined,
      values: {},
      initial: {},
      changed: [],
      inFlightBatches: 0,
      ...overrides,
    }),
  );

const fieldId = (path: string): string => 'field-' + path.replace(/[^a-z0-9]+/gi, '-');

describe('the editor is a five-block form (UX A-4, UI_SPEC §4.3)', () => {
  it('posts urlencoded fields to the series route with the revision hidden', () => {
    const { doc } = edit();
    const form = byTag(doc, 'form')[0]!;
    expect(form.attrs['id']).toBe('series-form');
    expect(form.attrs['method']).toBe('post');
    expect(form.attrs['action']).toBe('/series/' + detail.id);
    expect(form.attrs['novalidate']).toBeDefined();
    const hidden = byTag(form, 'input').find((node) => node.attrs['type'] === 'hidden');
    expect(hidden?.attrs['name']).toBe('revision');
    expect(hidden?.attrs['value']).toBe(String(detail.revision));
  });

  it('groups the fields into the primary and mode fieldsets, then the Advanced disclosure', () => {
    const { doc } = edit();
    expect(byTag(doc, 'fieldset')).toHaveLength(2);
    expect(byTag(doc, 'legend').map((node) => textOf(node))).toEqual(['Series', 'Mode']);
    expect(textOf(byTag(doc, 'summary')[0]!)).toBe('Advanced (defaults are fine)');
  });

  it('closes every fieldset it opens, so the mode radios stay inside the Mode block', () => {
    const { html, doc } = edit();
    expect((html.match(/<fieldset/g) ?? []).length).toBe(2);
    expect((html.match(/<\/fieldset>/g) ?? []).length).toBe(2);
    const mode = byTag(doc, 'fieldset').find((node) =>
      textOf(byTag(node, 'legend')[0]!).startsWith('Mode'),
    )!;
    const radios = byTag(mode, 'input').filter((node) => node.attrs['name'] === 'mode');
    expect(radios).toHaveLength(2);
  });

  it('shows the seven primary labels and folds the removed fields into Advanced only', () => {
    const { doc } = edit();
    const labels = byTag(doc, 'label').map((node) => textOf(node));
    for (const label of [
      'Series name',
      'Niche',
      'Example script',
      'Duration',
      'Language',
      'Voice ID',
      'Art style',
    ]) {
      expect(labels, label).toContain(label);
    }

    const details = byTag(doc, 'details')[0]!;
    const namesIn = (node: ReturnType<typeof parseHtml>): string[] =>
      [...byTag(node, 'input'), ...byTag(node, 'select'), ...byTag(node, 'textarea')]
        .map((control) => control.attrs['name'])
        .filter((name): name is string => name !== undefined);

    const inside = namesIn(details);
    const outside = namesIn(doc).filter((name) => !inside.includes(name));

    for (const name of [
      'niche.audience',
      'art_style.palette',
      'art_style.recurring_protagonist',
      'default_aspect_ratio',
      'image_resolution',
      'voice_config.speed',
    ]) {
      expect(inside, name).toContain(name);
      expect(outside, name).not.toContain(name);
    }
    // The visible primary art style stays outside the disclosure.
    expect(outside).toContain('art_style.preset');
    expect(inside).not.toContain('art_style.preset');
  });

  it('labels every control visibly and wires help and error text with aria-describedby', () => {
    const { doc } = edit();
    const controls = [
      ...byTag(doc, 'input'),
      ...byTag(doc, 'select'),
      ...byTag(doc, 'textarea'),
    ].filter((node) => node.attrs['type'] !== 'hidden');
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) {
      const id = control.attrs['id'];
      expect(id, control.attrs['name']).toBeDefined();
      const labels = byTag(doc, 'label').filter((label) => label.attrs['for'] === id);
      expect(labels.length, control.attrs['name']).toBeGreaterThanOrEqual(1);
      const describedBy = control.attrs['aria-describedby'];
      expect(describedBy, control.attrs['name']).toBeDefined();
      for (const target of describedBy!.split(/\s+/)) {
        expect(
          byTag(doc, 'p').some((node) => node.attrs['id'] === target),
          target,
        ).toBe(true);
      }
    }
  });

  it('never asks for a slug in either mode — it is derived from the name', () => {
    const { doc } = edit();
    expect(byTag(doc, 'input').some((node) => node.attrs['name'] === 'slug')).toBe(false);
    expect(textOf(doc)).not.toContain('The slug is fixed when the series is created.');

    const created = parseHtml(create().main);
    expect(byTag(created, 'input').some((node) => node.attrs['name'] === 'slug')).toBe(false);
  });

  it('shows the current version, mode, duration, aspect and open batches in the header', () => {
    const { doc } = edit();
    const chip = byTag(doc, 'span').find((node) => hasClass(node, 'series-version'))!;
    expect(textOf(chip)).toContain('v3');
    expect(accessibleTextOf(chip)).toBe('current version v3');
    const meta = textOf(byTag(doc, 'p').find((node) => hasClass(node, 'series-meta'))!);
    expect(meta).toContain('creative');
    expect(meta).toContain('75 s');
    expect(meta).toContain('9:16');
    expect(meta).toContain('1 open batch');
  });

  it('offers 9:16 and 4:5 as the only aspect frames and 1K/2K for images', () => {
    const { doc } = edit();
    const aspect = byTag(doc, 'select').find(
      (node) => node.attrs['name'] === 'default_aspect_ratio',
    )!;
    const options = byTag(aspect, 'option').map((option) => option.attrs['value']);
    expect(options).toEqual(['9:16', '4:5']);
    const resolution = byTag(doc, 'select').find(
      (node) => node.attrs['name'] === 'image_resolution',
    )!;
    expect(byTag(resolution, 'option').map((option) => option.attrs['value'])).toEqual([
      '1K',
      '2K',
    ]);
  });

  it('states what each mode enforces, with no silent default (R-027-1, IP-10)', () => {
    const { doc } = edit();
    const radios = byTag(doc, 'input').filter((node) => node.attrs['name'] === 'mode');
    expect(radios.map((radio) => radio.attrs['value'])).toEqual(['factual', 'creative']);
    expect(radios.filter((radio) => radio.attrs['checked'] !== undefined)).toHaveLength(1);
    const text = textOf(doc);
    expect(text).toContain(
      'Factual mode: every claim must resolve to a source before a script can be approved.',
    );
    expect(text).toContain(
      'Creative mode — citation enforcement does not apply. The mode is recorded in the export ' +
        'manifest.',
    );

    const created = parseHtml(create().main);
    const createdRadios = byTag(created, 'input').filter((node) => node.attrs['name'] === 'mode');
    expect(createdRadios.filter((radio) => radio.attrs['checked'] !== undefined)).toHaveLength(0);
  });
});

describe('the IP-02 commit panel', () => {
  it('is the aside region, headed Version commit, and owns the submit button', () => {
    const { panel } = edit();
    const heading = byTag(panel, 'h2').find((node) => node.attrs['id'] === 'commit-heading')!;
    expect(textOf(heading)).toBe('Version commit');
    const button = byTag(panel, 'button')[0]!;
    expect(button.attrs['type']).toBe('submit');
    expect(button.attrs['form']).toBe('series-form');
    expect(button.attrs['data-commit-button']).toBeDefined();
  });

  it('says the save mints the next version and that existing work is untouched (C-08)', () => {
    const { panel } = edit();
    const version = byTag(panel, 'strong').find(
      (node) => node.attrs['data-commit-version'] !== undefined,
    )!;
    expect(textOf(version)).toBe('v4');
    expect(accessibleTextOf(panel)).toContain(
      'Nothing is regenerated. 1 open batch keeps its current pins; stages that have not started ' +
        'will use v4 when they start. v3 stays immutable. Existing projects and their assets are ' +
        'untouched.',
    );
    expect(accessibleTextOf(panel)).toContain('Saving mints v4.');
  });

  it('disables Save and states No changes when nothing has changed', () => {
    const { panel } = edit();
    const button = byTag(panel, 'button')[0]!;
    expect(button.attrs['disabled']).toBeDefined();
    expect(textOf(button)).toBe('Save as v4');
    expect(button.attrs['aria-describedby']).toBe('commit-reason');
    const reason = byTag(panel, 'p').find((node) => node.attrs['id'] === 'commit-reason')!;
    expect(textOf(reason)).toBe('No changes');
  });

  it('enables Save, lists the change summary and marks the changed fields', () => {
    const changed = changedFields(initial, {
      ...values,
      'art_style.preset': 'flat-comic',
      'voice_config.speed': '1.1',
    });
    const { doc, panel } = edit({ changed });
    const button = byTag(panel, 'button')[0]!;
    expect(button.attrs['disabled']).toBeUndefined();
    expect(textOf(button)).toBe('Save as v4');

    const summary = byTag(panel, 'ul').find((node) => hasClass(node, 'series-summary'))!;
    const items = byTag(summary, 'li').filter((node) => node.attrs['hidden'] === undefined);
    expect(items.map((item) => textOf(item))).toEqual([
      'Art style: inking-comic → flat-comic',
      'Speed: 1 → 1.1',
    ]);

    for (const path of ['art_style.preset', 'voice_config.speed']) {
      const mark = byTag(doc, 'span').find((node) => node.attrs['data-changed-for'] === path)!;
      expect(textOf(mark)).toBe('Changed');
      expect(mark.attrs['hidden']).toBeUndefined();
      const wrapper = byTag(doc, 'div').find((node) => node.attrs['data-field-row'] === path)!;
      expect(wrapper.attrs['data-changed']).toBe('true');
    }
    const untouched = byTag(doc, 'span').find(
      (node) => node.attrs['data-changed-for'] === 'niche.subject',
    )!;
    expect(untouched.attrs['hidden']).toBeDefined();
  });

  it('renders the first-save consequence on the create form (UX A-5)', () => {
    const parts = create({ createReady: true });
    const panel = parseHtml(parts.aside);
    expect(textOf(byTag(panel, 'strong')[0]!)).toBe('v1');
    expect(accessibleTextOf(panel)).toContain(
      'This creates the series and mints v1. No project exists yet, so nothing is invalidated.',
    );
    expect(textOf(byTag(panel, 'button')[0]!)).toBe('Create series');
  });

  it('disables the blank create form with nothing to save', () => {
    const panel = parseHtml(create({ createReady: false }).aside);
    const button = byTag(panel, 'button')[0]!;
    expect(button.attrs['disabled']).toBeDefined();
    const reason = byTag(panel, 'p').find((node) => node.attrs['id'] === 'commit-reason')!;
    expect(textOf(reason)).toBe('Nothing to save.');
  });
});

describe('S-04 states (UX_SPEC §6.1)', () => {
  it('renders validation errors in place, preserves the typed value and wires aria-invalid', () => {
    const { doc, panel } = edit({
      values: { ...values, name: '', target_duration_s: '500' },
      changed: changedFields(initial, { ...values, target_duration_s: '500' }),
      errors: {
        name: 'Enter a series name.',
        target_duration_s: 'Target duration must be a whole number of seconds from 10 to 180.',
      },
    });

    const name = byTag(doc, 'input').find((node) => node.attrs['name'] === 'name')!;
    expect(name.attrs['aria-invalid']).toBe('true');
    expect(name.attrs['aria-describedby']).toContain('error-name');
    const error = byTag(doc, 'p').find((node) => node.attrs['id'] === 'error-name')!;
    expect(hasClass(error, 'series-field-error')).toBe(true);
    expect(textOf(error)).toBe('⚠ Enter a series name.');

    const duration = byTag(doc, 'input').find(
      (node) => node.attrs['name'] === 'target_duration_s',
    )!;
    expect(duration.attrs['value']).toBe('500');
    expect(textOf(byTag(panel, 'button')[0]!)).toBe('Save as v4');
  });

  it('renders the IP-09 conflict banner with the other tab, the preserved text and the choices', () => {
    const { doc, panel } = edit({
      values: { ...values, 'voice_config.speed': '1.3' },
      changed: changedFields(initial, { ...values, 'voice_config.speed': '1.3' }),
      conflict: {
        currentRevision: 5,
        yourRevision: 4,
        currentVersion: 4,
        savedAt: '2026-10-20T14:12:00.000Z',
      },
    });

    const conflict = byTag(doc, 'section').find((node) => hasClass(node, 'series-conflict'))!;
    expect(textOf(conflict)).toContain(
      'This series was saved by another tab at 2026-10-20T14:12:00Z (revision 5). Your revision ' +
        '4 was not saved. Nothing was overwritten.',
    );
    const discard = byTag(conflict, 'a').find((node) => textOf(node) === 'Discard mine')!;
    expect(discard.attrs['href']).toBe('/series/' + detail.id);

    const hidden = byTag(doc, 'input').find((node) => node.attrs['name'] === 'revision')!;
    expect(hidden.attrs['value']).toBe('5');
    const speed = byTag(doc, 'input').find((node) => node.attrs['name'] === 'voice_config.speed')!;
    expect(speed.attrs['value']).toBe('1.3');
    expect(textOf(byTag(panel, 'button')[0]!)).toBe('Save as v5');
  });

  it('makes an archived series read-only with the R-001-3 reason and no submit', () => {
    const { doc, panel } = edit({
      status: 'archived',
      detail: SeriesDetailSchema.parse({ ...detail, status: 'archived' }),
    });
    const notice = byTag(doc, 'section').find((node) => hasClass(node, 'series-archived'))!;
    expect(textOf(notice)).toBe('Archived series cannot be edited or used for new batches.');
    expect(byTag(panel, 'button')).toHaveLength(0);
    const textInputs = byTag(doc, 'input').filter(
      (node) => node.attrs['type'] !== 'hidden' && node.attrs['type'] !== 'radio',
    );
    for (const input of textInputs) {
      expect(input.attrs['readonly'] ?? input.attrs['disabled']).toBeDefined();
    }
  });

  it('confirms the mint after a redirect without a toast (IP-02)', () => {
    const { doc } = edit({
      detail: SeriesDetailSchema.parse({ ...detail, current_version: 4 }),
      savedVersion: 4,
    });
    const saved = byTag(doc, 'p').find((node) => hasClass(node, 'series-saved'))!;
    expect(textOf(saved)).toBe('Saved as v4');
    expect(saved.attrs['data-message']).toBe(
      'Saved as v4. Existing projects and their assets are untouched.',
    );
    expect(renderSeriesEditor(base({ savedVersion: 4 })).main).not.toContain('toast');
  });
});

describe('markup rules', () => {
  it('carries no inline style, script or event handler (CSP)', () => {
    const { html } = edit({ changed: changedFields(initial, { ...values, name: 'X' }) });
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toContain('onclick=');
  });

  it('never autofocuses a save control and never hides the label behind a placeholder', () => {
    const { panel } = edit();
    const button = byTag(panel, 'button')[0]!;
    expect(button.attrs['autofocus']).toBeUndefined();
    const { doc } = edit();
    for (const input of byTag(doc, 'input')) {
      expect(input.attrs['placeholder']).toBeUndefined();
    }
  });

  it('gives every field a stable id derived from its path', () => {
    const { doc } = edit();
    for (const path of ['voice_config.speed', 'art_style.recurring_protagonist', 'mode']) {
      const node = byTag(doc, 'input').find((input) => input.attrs['name'] === path)!;
      expect(node.attrs['id']).toBe(fieldId(path));
    }
  });
});
