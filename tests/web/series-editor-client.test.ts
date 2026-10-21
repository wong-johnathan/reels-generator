import { describe, expect, it } from 'vitest';

import {
  initSeriesEditor,
  readFieldValue,
  savingState,
  type EditorDocumentLike,
  type EditorElementLike,
  type EditorEventLike,
} from '../../src/web/client/seriesEditor.js';
import { FIELDS } from '../../src/web/series/fields.js';

/**
 * S-04 progressive enhancement (UI_SPEC §6.1 S-04 states, IP-02, UC-19,
 * UC-18 loading labels).
 *
 * The server renders every state; this module adds the two things HTML alone
 * cannot: re-computing the changed-field marks and the commit panel while the
 * operator types, and the minting busy state that blocks a double submit.
 * Rules are pure; the DOM binding runs against fakes like the login client.
 */

interface FakeElement extends EditorElementLike {
  readonly attrs: Map<string, string>;
  readonly events: Map<string, Array<(event?: EditorEventLike) => void>>;
  readonly tag: string;
  textContent: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, handler: (event?: EditorEventLike) => void): void;
  emit(name: string): void;
}

function element(
  tag: string,
  attrs: Record<string, string> = {},
  extra: Partial<FakeElement> = {},
): FakeElement {
  const map = new Map(Object.entries(attrs));
  const events = new Map<string, Array<(event?: EditorEventLike) => void>>();
  const node: FakeElement = {
    ...extra,
    tag,
    attrs: map,
    events,
    textContent: '',
    getAttribute(name: string): string | null {
      return map.get(name) ?? null;
    },
    setAttribute(name: string, value: string): void {
      map.set(name, value);
    },
    addEventListener(name: string, handler: (event?: EditorEventLike) => void): void {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
    },
    emit(name: string): void {
      for (const handler of events.get(name) ?? []) handler({ preventDefault() {} });
    },
  };
  return node;
}

interface FakePage {
  readonly doc: EditorDocumentLike;
  readonly form: FakeElement;
  readonly button: FakeElement;
  readonly reason: FakeElement;
  readonly version: FakeElement;
  readonly body: FakeElement;
  readonly empty: FakeElement;
  readonly live: FakeElement;
  readonly fields: Map<string, FakeElement>;
  readonly marks: Map<string, FakeElement>;
  readonly summaries: Map<string, FakeElement>;
}

function page(
  values: Record<string, string>,
  options: { mode?: 'create' | 'edit'; live?: string } = {},
): FakePage {
  const mode = options.mode ?? 'edit';
  const form = element('form', {
    'data-series-form': '',
    'data-mode': mode,
    'data-current-version': mode === 'edit' ? '3' : '0',
    'data-in-flight-batches': mode === 'edit' ? '1' : '0',
  });
  const fields = new Map<string, FakeElement>();
  for (const field of FIELDS) {
    const initial = values[field.path] ?? '';
    const attrs: Record<string, string> = {
      'data-field': field.path,
      'data-kind': field.kind,
      'data-initial': initial,
      id: 'field-' + field.path.replace(/[^a-z0-9]+/gi, '-'),
    };
    const extra: Partial<FakeElement> =
      field.kind === 'checkbox' ? { checked: initial === 'true' } : { value: initial };
    fields.set(field.path, element(field.kind === 'checkbox' ? 'input' : 'input', attrs, extra));
  }
  const marks = new Map<string, FakeElement>();
  const summaries = new Map<string, FakeElement>();
  for (const field of FIELDS) {
    marks.set(field.path, element('span', { 'data-changed-for': field.path }, { hidden: true }));
    summaries.set(field.path, element('li', { 'data-summary-for': field.path }, { hidden: true }));
  }
  const button = element('button', { 'data-commit-button': '' }, { disabled: true });
  const reason = element('p', { 'data-commit-reason': '' });
  const version = element('strong', { 'data-commit-version': '' });
  const body = element('p', { 'data-commit-body': '' });
  const empty = element('p', { 'data-change-empty': '' });
  const live = element('div', { id: 'live-status', 'data-message': options.live ?? '' });

  const bySelector: Record<string, FakeElement> = {
    '[data-series-form]': form,
    '[data-commit-button]': button,
    '[data-commit-reason]': reason,
    '[data-commit-version]': version,
    '[data-commit-body]': body,
    '[data-change-empty]': empty,
    '#live-status': live,
  };

  const doc: EditorDocumentLike = {
    querySelector: (selector: string) => bySelector[selector] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-field]') return [...fields.values()];
      if (selector === '[data-changed-for]') return [...marks.values()];
      if (selector === '[data-summary-for]') return [...summaries.values()];
      return [];
    },
  };

  return { doc, form, button, reason, version, body, empty, live, fields, marks, summaries };
}

const baseValues: Record<string, string> = {
  name: 'Founders, Quietly',
  'niche.subject': 'psychology for founders',
  'niche.boundaries': 'no medical advice',
  'script_style.structure': 'hook\ntension\nturn\nlanding',
  'voice_config.speed': '1',
  'art_style.recurring_protagonist': 'true',
  default_aspect_ratio: '9:16',
  target_duration_s: '75',
  image_resolution: '1K',
  mode: 'creative',
};

const type = (p: FakePage, path: string, value: string): void => {
  const field = p.fields.get(path)!;
  if (field.getAttribute('data-kind') === 'checkbox') field.checked = value === 'true';
  else field.value = value;
  p.form.emit('input');
};

describe('field reading', () => {
  it('reads a checkbox as true/false and everything else as its value', () => {
    expect(readFieldValue(element('input', { 'data-kind': 'checkbox' }, { checked: true }))).toBe(
      'true',
    );
    expect(readFieldValue(element('input', { 'data-kind': 'checkbox' }, { checked: false }))).toBe(
      'false',
    );
    expect(readFieldValue(element('input', { 'data-kind': 'text' }, { value: 'abc' }))).toBe('abc');
    expect(readFieldValue(element('input', { 'data-kind': 'text' }, { value: undefined }))).toBe(
      '',
    );
  });
});

describe('live changed marks and commit panel (UI_SPEC §6.1 S-04)', () => {
  it('binds the form and shows the unchanged state', () => {
    const p = page(baseValues);
    expect(initSeriesEditor(p.doc)).toBe(true);
    expect(p.button.disabled).toBe(true);
    expect(p.button.textContent).toBe('Save as v4');
    expect(p.reason.textContent).toBe('No changes');
    expect(p.reason.hidden).toBe(false);
    expect(p.button.getAttribute('aria-describedby')).toBe('commit-reason');
    for (const mark of p.marks.values()) expect(mark.hidden).toBe(true);
  });

  it('enables the mint and marks exactly the changed field', () => {
    const p = page(baseValues);
    initSeriesEditor(p.doc);
    type(p, 'voice_config.speed', '1.2');

    expect(p.button.disabled).toBe(false);
    expect(p.version.textContent).toBe('v4');
    expect(p.body.textContent).toBe(
      'Nothing is regenerated. 1 open batch keeps its current pins; stages that have not started ' +
        'will use v4 when they start. v3 stays immutable. Existing projects and their assets are ' +
        'untouched.',
    );
    expect(p.reason.hidden).toBe(true);
    expect(p.empty.hidden).toBe(true);
    expect(p.marks.get('voice_config.speed')?.hidden).toBe(false);
    expect(p.marks.get('niche.subject')?.hidden).toBe(true);
    const summary = p.summaries.get('voice_config.speed')!;
    expect(summary.hidden).toBe(false);
    expect(summary.textContent).toBe('Speed: 1 → 1.2');
  });

  it('returns to the disabled state when the edit is undone', () => {
    const p = page(baseValues);
    initSeriesEditor(p.doc);
    type(p, 'voice_config.speed', '1.2');
    type(p, 'voice_config.speed', '1');
    expect(p.button.disabled).toBe(true);
    expect(p.reason.textContent).toBe('No changes');
    expect(p.marks.get('voice_config.speed')?.hidden).toBe(true);
    expect(p.summaries.get('voice_config.speed')?.hidden).toBe(true);
    expect(p.empty.hidden).toBe(false);
  });

  it('treats an unticked checkbox as a change', () => {
    const p = page(baseValues);
    initSeriesEditor(p.doc);
    type(p, 'art_style.recurring_protagonist', 'false');
    expect(p.button.disabled).toBe(false);
    expect(p.summaries.get('art_style.recurring_protagonist')?.textContent).toBe(
      'Recurring protagonist: yes → no',
    );
  });

  it('keeps a blank create form disabled until name, niche and mode exist', () => {
    const p = page({ target_duration_s: '75' }, { mode: 'create' });
    expect(initSeriesEditor(p.doc)).toBe(true);
    expect(p.button.textContent).toBe('Create series');
    expect(p.reason.textContent).toBe('Nothing to save.');
    type(p, 'name', 'Second series');
    expect(p.button.disabled).toBe(true);
    type(p, 'niche.subject', 'psychology');
    expect(p.button.disabled).toBe(true);
    type(p, 'mode', 'factual');
    expect(p.button.disabled).toBe(false);
    expect(p.version.textContent).toBe('v1');
    expect(p.body.textContent).toBe('No project exists yet, so nothing is invalidated.');
  });

  it('summarises the create form with name, niche, duration and mode, not defaults', () => {
    const p = page({ target_duration_s: '75' }, { mode: 'create' });
    initSeriesEditor(p.doc);
    type(p, 'name', 'Founders, Quietly');
    type(p, 'niche.subject', 'psychology');
    type(p, 'mode', 'factual');
    expect(p.summaries.get('name')?.hidden).toBe(false);
    expect(p.summaries.get('name')?.textContent).toBe('Series name: Founders, Quietly');
    expect(p.summaries.get('niche.subject')?.textContent).toBe('Niche: psychology');
    expect(p.summaries.get('target_duration_s')?.textContent).toBe('Duration: 75');
    expect(p.summaries.get('mode')?.textContent).toBe('Mode: factual');
    expect(p.summaries.get('image_resolution')?.hidden).toBe(true);
    expect(p.empty.hidden).toBe(true);
  });
});

describe('submitting (UC-18 loading label)', () => {
  it('names the mint, blocks a second submit and stays enabled-looking to AT', () => {
    const p = page({ ...baseValues, 'voice_config.speed': '1.2' });
    initSeriesEditor(p.doc);
    type(p, 'voice_config.speed', '1.2');
    p.form.emit('submit');

    expect(p.button.disabled).toBe(true);
    expect(p.button.textContent).toBe('Minting v4…');
    expect(p.form.getAttribute('aria-busy')).toBe('true');

    p.button.disabled = false;
    p.form.emit('submit');
    expect(p.button.textContent).toBe('Minting v4…');
  });

  it('uses the present-participle create label on a first save', () => {
    const p = page({ name: 'Second series', mode: 'factual' }, { mode: 'create' });
    initSeriesEditor(p.doc);
    p.form.emit('submit');
    expect(p.button.textContent).toBe('Creating…');
    expect(savingState('create', 1)).toEqual({ label: 'Creating…', busy: true });
    expect(savingState('edit', 4)).toEqual({ label: 'Minting v4…', busy: true });
  });
});

describe('post-save announcement (§8.5)', () => {
  it('writes the server announcement into the polite region once', () => {
    const p = page(baseValues, {
      live: 'Saved as v4. Existing projects and their assets are untouched.',
    });
    initSeriesEditor(p.doc);
    expect(p.live.textContent).toBe(
      'Saved as v4. Existing projects and their assets are untouched.',
    );
    expect(p.live.getAttribute('data-message')).toBe('');
  });

  it('does nothing when there is no editor form', () => {
    const doc: EditorDocumentLike = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    expect(initSeriesEditor(doc)).toBe(false);
  });
});
