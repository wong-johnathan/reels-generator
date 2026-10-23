import { describe, expect, it } from 'vitest';

import { initMonitoring } from '../../src/web/client/behaviours.js';
import { FIELDS } from '../../src/web/series/fields.js';

function node(attrs: Record<string, string> = {}, value?: string) {
  return {
    value,
    textContent: '',
    checked: false,
    getAttribute: (key: string) => attrs[key] ?? null,
  };
}

describe('progressive monitoring synchronization', () => {
  it('returns a sync hook for async source updates without input or resize', async () => {
    const message = node();
    message.textContent = 'computing impact';
    const summary = node({ 'data-monitor-text-for': 'script-impact-message' });
    const doc = {
      querySelector: () => message,
      querySelectorAll: (selector: string) =>
        selector === '[data-monitor-text-for]' ? [summary] : [],
    };
    const sync = initMonitoring(doc, {}, 'script', {});
    expect(summary.textContent).toBe('computing impact');
    await Promise.resolve();
    message.textContent = 'Script rev 5 → rev 6 · wording only';
    sync();
    expect(summary.textContent).toBe(message.textContent);
  });

  it('reflects unsaved edits on resize and input without adding mutation hooks', () => {
    const source = node({}, 'server');
    const copy = node({ 'data-monitor-for': 'script-body' }, 'server');
    const message = node();
    message.textContent = 'No unsaved changes';
    const summary = node({ 'data-monitor-text-for': 'script-impact-message' });
    const events: Record<string, () => void> = {};
    const doc = {
      querySelector: (selector: string) => (selector === '#script-body' ? source : message),
      querySelectorAll: (selector: string) =>
        selector === '[data-monitor-for]' ? [copy] : [summary],
    };
    const target = {
      addEventListener: (type: string, handler: () => void) => {
        events[type] = handler;
      },
    };
    initMonitoring(doc, target, 'script', target);
    source.value = 'unsaved <text>';
    message.textContent = 'Preview ready';
    events['resize']!();
    expect(copy.value).toBe('unsaved <text>');
    expect(summary.textContent).toBe('Preview ready');
    source.value = 'second edit';
    events['input']!();
    expect(copy.value).toBe('second edit');
  });
  it('copies selected radio/select labels and checkbox states as text, not editable values', () => {
    const radio = node({ 'data-field': 'mode', 'data-kind': 'radio' }, 'creative');
    radio.checked = true;
    const unchecked = node({ 'data-field': 'mode', 'data-kind': 'radio' }, 'factual');
    const check = node(
      { 'data-field': 'art_style.recurring_protagonist', 'data-kind': 'checkbox' },
      'true',
    );
    check.checked = true;
    const modeCopy = node({ 'data-monitor-for': 'mode' });
    const checkCopy = node({ 'data-monitor-for': 'art_style.recurring_protagonist' });
    const select = node({ 'data-field': 'default_aspect_ratio', 'data-kind': 'select' }, '9:16');
    const selectCopy = node({ 'data-monitor-for': 'default_aspect_ratio' });
    const doc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === '[data-field]'
          ? [unchecked, radio, check, select]
          : selector === '[data-monitor-for]'
            ? [modeCopy, checkCopy, selectCopy]
            : [],
    };
    initMonitoring(doc, {}, 'series', {}, FIELDS);
    expect(modeCopy.textContent).toBe('Creative');
    expect(checkCopy.textContent).toBe('Yes');
    expect(selectCopy.textContent).toBe('9:16 — 1080×1920');
  });
});
