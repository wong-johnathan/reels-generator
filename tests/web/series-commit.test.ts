import { describe, expect, it } from 'vitest';

import { commitState, savedAnnouncement } from '../../src/web/series/commit.js';
import type { ChangedField } from '../../src/web/series/fields.js';

/**
 * IP-02 — the series version mint (UX_SPEC §4 "IP-02 — Series version mint",
 * UI_SPEC §6.1 S-04 states, UI_SPEC C-08).
 *
 * The signal line for F-03 is that editing a series shows the version-mint
 * commit *and* that existing projects/assets are untouched (R-002-3). These
 * are the exact strings; the renderer and the client both read them from here
 * so the panel cannot drift between server HTML and a live edit.
 */

const changed: ChangedField[] = [
  {
    path: 'art_style.preset',
    label: 'Art preset',
    block: 'art',
    blockTitle: 'Art & references',
    from: 'inking-comic',
    to: 'flat-comic',
  },
  {
    path: 'voice_config.speed',
    label: 'Speed',
    block: 'voice',
    blockTitle: 'Voice & narration',
    from: '1',
    to: '1.1',
  },
];

describe('the commit panel states (IP-02)', () => {
  it('an unchanged edit is disabled and says so', () => {
    const state = commitState({ mode: 'edit', currentVersion: 3, changed: [] });
    expect(state.saveDisabled).toBe(true);
    expect(state.reason).toBe('No changes');
    expect(state.saveLabel).toBe('Save as v4');
    expect(state.busy).toBe(false);
  });

  it('a changed edit enables the labelled mint', () => {
    const state = commitState({ mode: 'edit', currentVersion: 3, changed });
    expect(state.saveDisabled).toBe(false);
    expect(state.reason).toBe('');
    expect(state.saveLabel).toBe('Save as v4');
    expect(state.nextVersion).toBe(4);
  });

  it('a blank new profile is disabled until it has something to save', () => {
    const blank = commitState({
      mode: 'create',
      currentVersion: 0,
      changed: [],
      createReady: false,
    });
    expect(blank.saveDisabled).toBe(true);
    expect(blank.reason).toBe('Nothing to save.');
    expect(blank.saveLabel).toBe('Create series');

    const ready = commitState({
      mode: 'create',
      currentVersion: 0,
      changed: [],
      createReady: true,
    });
    expect(ready.saveDisabled).toBe(false);
  });

  it('an archived series is disabled with the R-001-3 reason', () => {
    const state = commitState({ mode: 'edit', currentVersion: 3, changed, archived: true });
    expect(state.saveDisabled).toBe(true);
    expect(state.reason).toBe('Archived series cannot be edited or used for new batches.');
  });

  it('names the mint in flight, never just a spinner (UC-18)', () => {
    expect(commitState({ mode: 'edit', currentVersion: 3, changed, saving: true }).saveLabel).toBe(
      'Minting v4…',
    );
    expect(
      commitState({
        mode: 'create',
        currentVersion: 0,
        changed: [],
        createReady: true,
        saving: true,
      }).saveLabel,
    ).toBe('Creating…');
  });
});

describe('the consequence sentence (C-08 + R-002-3)', () => {
  it('renders C-08 verbatim when the in-flight video count is sourced', () => {
    const state = commitState({
      mode: 'edit',
      currentVersion: 13,
      changed,
      inFlightVideos: 30,
    });
    expect(state.version).toBe('v14');
    expect(state.lead).toBe('Saving mints v14.');
    expect(state.body).toBe(
      'Nothing is regenerated. 30 videos keep their current pins; stages that have not started ' +
        'will use v14 when they start. v13 stays immutable. Existing projects and their assets ' +
        'are untouched.',
    );
  });

  it('falls back to the open-batch count the contract actually exposes', () => {
    const state = commitState({
      mode: 'edit',
      currentVersion: 3,
      changed,
      inFlightBatches: 1,
    });
    expect(state.body).toBe(
      'Nothing is regenerated. 1 open batch keeps its current pins; stages that have not started ' +
        'will use v4 when they start. v3 stays immutable. Existing projects and their assets are ' +
        'untouched.',
    );
  });

  it('pluralises open batches and says nothing is invalidated when no project exists', () => {
    expect(
      commitState({ mode: 'edit', currentVersion: 3, changed, inFlightBatches: 2 }).body,
    ).toContain('2 open batches keep their current pins;');
    expect(commitState({ mode: 'edit', currentVersion: 3, changed, inFlightBatches: 0 }).body).toBe(
      'Nothing is regenerated. No project exists yet, so nothing is invalidated. v3 stays ' +
        'immutable.',
    );
    expect(commitState({ mode: 'edit', currentVersion: 3, changed }).body).toBe(
      'Nothing is regenerated. No project exists yet, so nothing is invalidated. v3 stays ' +
        'immutable.',
    );
  });

  it('states the first save as version 1 with nothing to invalidate (UX A-5)', () => {
    const state = commitState({
      mode: 'create',
      currentVersion: 0,
      changed: [],
      createReady: true,
    });
    expect(state.version).toBe('v1');
    expect(state.lead).toBe('This creates the series and mints v1.');
    expect(state.body).toBe('No project exists yet, so nothing is invalidated.');
  });

  it('never uses invalidation language for a profile edit (IP-02 rule)', () => {
    const body = commitState({
      mode: 'edit',
      currentVersion: 3,
      changed,
      inFlightVideos: 30,
    }).body;
    expect(body).not.toMatch(/stale|invalidat(es|ed) (the|scene|image|script)/i);
    expect(body).toContain('Nothing is regenerated.');
  });
});

describe('the change summary', () => {
  it('prints field, old value and new value in form order', () => {
    const state = commitState({ mode: 'edit', currentVersion: 3, changed });
    expect(state.summary).toEqual(['Art preset: inking-comic → flat-comic', 'Speed: 1 → 1.1']);
  });

  it('is empty for an unchanged form', () => {
    expect(commitState({ mode: 'edit', currentVersion: 3, changed: [] }).summary).toEqual([]);
  });
});

describe('the post-save announcement (UI_SPEC §8.5)', () => {
  it('names the minted version and the untouched projects', () => {
    expect(savedAnnouncement({ version: 4, inFlightVideos: 30 })).toBe(
      'Saved as v4. Existing projects and their assets are untouched.',
    );
  });

  it('does not claim projects exist when none do', () => {
    expect(savedAnnouncement({ version: 4 })).toBe('Saved as v4.');
    expect(savedAnnouncement({ version: 1, created: true })).toBe('Saved as v1.');
  });
});
