import { describe, expect, it } from 'vitest';

import { SeriesProfileSchema, SeriesVersionDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  BLOCKS,
  FIELDS,
  FIELD_BY_PATH,
  changedFields,
  createReady,
  createSummary,
  defaultProfile,
  deriveSlug,
  profileToValues,
  validateSeriesValues,
  valuesFromForm,
  valuesToProfile,
} from '../../src/web/series/fields.js';

/**
 * S-04 field model: the seven primary inputs plus a mode radio, with every
 * remaining profile leaf folded into the Advanced block, and R-002-1: every
 * save is a version mint, so the form must be able to say exactly which fields
 * changed.
 *
 * These are the pure rules the server renderer and the client enhancer share;
 * no DOM, no network, no provider.
 */

const profile = SeriesProfileSchema.parse(
  SeriesVersionDetailSchema.parse(FIXTURES['series.versions.get']).snapshot,
);

describe('the field blocks', () => {
  it('renders the primary inputs, mode and Advanced in that order', () => {
    expect(BLOCKS.map((block) => block.title)).toEqual([
      'Series',
      'Mode',
      'Advanced (defaults are fine)',
    ]);
    expect(BLOCKS.map((block) => block.id)).toEqual(['primary', 'mode', 'advanced']);
  });

  it('gives every field one block, one visible label and one unique path', () => {
    const paths = FIELDS.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const field of FIELDS) {
      expect(
        BLOCKS.some((block) => block.id === field.block),
        field.path,
      ).toBe(true);
      expect(field.label.trim().length, field.path).toBeGreaterThan(0);
      expect(FIELD_BY_PATH.get(field.path), field.path).toBe(field);
    }
  });

  it('keeps exactly the eight primary inputs and the mode radio outside Advanced', () => {
    const primary = FIELDS.filter((field) => field.block === 'primary').map((field) => field.path);
    expect(primary).toEqual([
      'name',
      'niche.subject',
      'script_style.example_script',
      'target_duration_s',
      'videos_per_batch',
      'narration_language',
      'voice_config.voice_id',
      'art_style.preset',
    ]);
    expect(FIELDS.filter((field) => field.block === 'mode').map((field) => field.path)).toEqual([
      'mode',
    ]);
    const advanced = FIELDS.filter((field) => field.block === 'advanced').map(
      (field) => field.path,
    );
    expect(advanced).toContain('art_style.palette');
    expect(advanced).toContain('art_style.recurring_protagonist');
    expect(advanced).not.toContain('art_style.preset');
    expect(advanced).not.toContain('name');
    expect(advanced).not.toContain('mode');
  });

  it('covers every editable profile leaf the contract exposes', () => {
    const paths = new Set(FIELDS.map((field) => field.path));
    for (const path of [
      'name',
      'niche.subject',
      'niche.audience',
      'niche.boundaries',
      'niche.language',
      'niche.location',
      'niche.prohibited_topics',
      'niche.preferred_sources',
      'script_style.example_script',
      'script_style.tone',
      'script_style.structure',
      'voice_config.voice_id',
      'voice_config.speed',
      'voice_config.style',
      'art_style.preset',
      'art_style.palette',
      'art_style.recurring_protagonist',
      'default_aspect_ratio',
      'target_duration_s',
      'videos_per_batch',
      'narration_language',
      'image_resolution',
      'mode',
    ]) {
      expect(paths.has(path), path).toBe(true);
    }
  });

  it('derives the slug instead of asking for it, so it is not a form field', () => {
    expect(FIELD_BY_PATH.has('slug')).toBe(false);
    // Name lives on the series row, not inside the version snapshot.
    expect(profile).not.toHaveProperty('name');
    expect(profile).not.toHaveProperty('slug');
  });
});

describe('slug derivation', () => {
  it('derives kebab-case from the name, collapsing non-alphanumerics', () => {
    expect(deriveSlug('Nick & Grace!')).toBe('nick-grace');
    expect(deriveSlug('Founders, Quietly')).toBe('founders-quietly');
    expect(deriveSlug('Café Society')).toBe('cafe-society');
    expect(deriveSlug('  ---  ')).toBe('');
    expect(deriveSlug('')).toBe('');
  });
});

describe('profile <-> form values', () => {
  it('flattens the fixture profile into the form, one line per list item', () => {
    const values = profileToValues(profile);
    expect(values['niche.subject']).toBe('psychology for founders');
    expect(values['niche.boundaries']).toBe('no medical advice');
    expect(values['niche.prohibited_topics']).toBe('politics');
    expect(values['script_style.structure']).toBe('hook\ntension\nturn\nlanding');
    expect(values['script_style.example_script']).toBe('');
    expect(values['voice_config.speed']).toBe('1');
    expect(values['art_style.preset']).toBe('inking-comic');
    expect(values['art_style.recurring_protagonist']).toBe('true');
    expect(values['default_aspect_ratio']).toBe('9:16');
    expect(values['target_duration_s']).toBe('75');
    expect(values['narration_language']).toBe('en');
    expect(values.mode).toBe('creative');
  });

  it('round-trips the profile through the form without losing a value', () => {
    // A profile written today carries the batch size; profiles from before the
    // field existed fall back to 1 through the field's initial value.
    const current = { ...profile, videos_per_batch: 3 };
    const rebuilt = valuesToProfile(profileToValues(current), current);
    expect(rebuilt).toEqual(current);
    expect(SeriesProfileSchema.parse(rebuilt)).toEqual(current);
  });

  it('falls back to one video for a profile written before the field existed', () => {
    expect(profileToValues(profile)['videos_per_batch']).toBe('1');
  });

  it('keeps a blank example script out of the snapshot (it is optional)', () => {
    const rebuilt = valuesToProfile(profileToValues(profile), profile);
    expect((rebuilt['script_style'] as Record<string, unknown>)['example_script']).toBeUndefined();
    const filled = valuesToProfile(
      { ...profileToValues(profile), 'script_style.example_script': 'A sample narration.' },
      profile,
    );
    expect((filled['script_style'] as Record<string, unknown>)['example_script']).toBe(
      'A sample narration.',
    );
  });

  it('preserves fields the form does not edit (captions, music) and unknown keys', () => {
    const extended = {
      ...profile,
      captions_preset: { words_per_caption: 3, emphasis: true },
      music_config: null,
      niche: { ...profile.niche, audience: 'solo builders', internal_note: 'keep me' },
    };
    const rebuilt = valuesToProfile(profileToValues(extended), extended);
    expect(rebuilt['captions_preset']).toEqual({ words_per_caption: 3, emphasis: true });
    expect(rebuilt['music_config']).toBeNull();
    expect((rebuilt['niche'] as Record<string, unknown>)['internal_note']).toBe('keep me');
  });

  it('builds a complete, schema-valid profile for a new series', () => {
    const values = valuesFromForm({
      name: 'New series',
      'niche.subject': 'psychology',
      mode: 'factual',
      target_duration_s: '75',
    });
    const built = valuesToProfile(values, null);
    const parsed = SeriesProfileSchema.parse(built);
    expect(parsed.mode).toBe('factual');
    expect(parsed.target_duration_s).toBe(75);
    expect(parsed.default_aspect_ratio).toBe('9:16');
    expect(parsed.image_resolution).toBe('1K');
    expect(parsed.narration_language).toBe('en');
    expect(parsed.niche).toMatchObject({ subject: 'psychology' });
    expect(parsed.music_config).toBeNull();
  });

  it('defaults the hidden leaves: 9:16, 1K, recurring protagonist, en', () => {
    const values = valuesFromForm({});
    expect(values['default_aspect_ratio']).toBe('9:16');
    expect(values['image_resolution']).toBe('1K');
    expect(values['art_style.recurring_protagonist']).toBe('true');
    expect(values['target_duration_s']).toBe('75');
    expect(values['narration_language']).toBe('en');
    expect(values['voice_config.speed']).toBe('1');
  });

  it('normalises an absent checkbox and ignores unknown form keys', () => {
    const values = valuesFromForm({
      name: 'New series',
      'art_style.recurring_protagonist': 'on',
      'not.a.field': 'ignored',
    });
    expect(values['art_style.recurring_protagonist']).toBe('true');
    expect(values).not.toHaveProperty('not.a.field');
    expect(values).not.toHaveProperty('slug');
  });
});

describe('changed fields — the change summary IP-02 requires', () => {
  const before = profileToValues(profile);

  it('reports nothing when the form matches the stored version', () => {
    expect(changedFields(before, { ...before })).toEqual([]);
  });

  it('names the field, its block and the old and new value', () => {
    const after = { ...before, 'voice_config.speed': '1.2' };
    expect(changedFields(before, after)).toEqual([
      {
        path: 'voice_config.speed',
        label: 'Speed',
        block: 'advanced',
        blockTitle: 'Advanced (defaults are fine)',
        from: '1',
        to: '1.2',
      },
    ]);
  });

  it('orders changes by the form, not by the map', () => {
    const after = {
      ...before,
      mode: 'factual',
      'niche.subject': 'psychology for teams',
      'art_style.preset': 'flat-comic',
    };
    expect(changedFields(before, after).map((change) => change.path)).toEqual([
      'niche.subject',
      'art_style.preset',
      'mode',
    ]);
  });

  it('shows list fields as comma-separated values and empty as a word', () => {
    const after = {
      ...before,
      'niche.boundaries': 'no medical advice\nno legal advice',
      'script_style.structure': '',
    };
    const changes = changedFields(before, after);
    expect(changes.map((change) => change.to)).toEqual([
      'no medical advice, no legal advice',
      '(empty)',
    ]);
    expect(changes[1]?.from).toBe('hook, tension, turn, landing');
  });

  it('turns the checkbox into yes/no rather than a raw attribute value', () => {
    const after = { ...before, 'art_style.recurring_protagonist': 'false' };
    expect(changedFields(before, after)).toMatchObject([{ from: 'yes', to: 'no' }]);
  });

  it('includes the series name when it changes (the name is saved with the version)', () => {
    const after = { ...before, name: 'Founders, Loudly' };
    expect(changedFields({ ...before, name: 'Founders, Quietly' }, after)).toMatchObject([
      { path: 'name', label: 'Series name', from: 'Founders, Quietly', to: 'Founders, Loudly' },
    ]);
  });
});

describe('the create summary', () => {
  it('lists name, niche, duration and mode — never the defaulted fields', () => {
    const summary = createSummary(valuesFromForm({}));
    expect(summary.map((row) => row.path)).toEqual([
      'name',
      'niche.subject',
      'target_duration_s',
      'videos_per_batch',
      'mode',
    ]);
    expect(summary.map((row) => row.label)).toEqual([
      'Series name',
      'Niche',
      'Duration',
      'Videos per batch',
      'Mode',
    ]);
    expect(summary.map((row) => row.path)).not.toContain('image_resolution');
    expect(summary.map((row) => row.path)).not.toContain('default_aspect_ratio');
  });
});

describe('createReady — the readiness rule', () => {
  const base = valuesFromForm({});

  it('is false for a blank form', () => {
    expect(createReady(base)).toBe(false);
  });

  it('needs a name, a niche, a valid duration and a mode', () => {
    expect(createReady({ ...base, name: 'X', 'niche.subject': 'Y', mode: 'factual' })).toBe(true);
    expect(createReady({ ...base, 'niche.subject': 'Y', mode: 'factual' })).toBe(false);
    expect(createReady({ ...base, name: 'X', mode: 'factual' })).toBe(false);
    expect(createReady({ ...base, name: 'X', 'niche.subject': 'Y' })).toBe(false);
  });

  it('does not require a slug or a voice id', () => {
    expect(
      createReady({
        ...base,
        name: 'X',
        'niche.subject': 'Y',
        mode: 'factual',
        'voice_config.voice_id': '',
      }),
    ).toBe(true);
  });

  it('rejects a blank, non-numeric or out-of-range duration', () => {
    const rest = { ...base, name: 'X', 'niche.subject': 'Y', mode: 'factual' };
    expect(createReady({ ...rest, target_duration_s: '' })).toBe(false);
    expect(createReady({ ...rest, target_duration_s: 'abc' })).toBe(false);
    expect(createReady({ ...rest, target_duration_s: '9' })).toBe(false);
    expect(createReady({ ...rest, target_duration_s: '181' })).toBe(false);
  });
});

describe('validation (R-001-1, R-009-1, R-027-1)', () => {
  const valid = valuesFromForm({
    name: 'Founders, Quietly',
    'niche.subject': 'psychology',
    mode: 'creative',
    target_duration_s: '75',
  });

  it('accepts a complete form', () => {
    expect(validateSeriesValues(valid, 'create').errors).toEqual({});
  });

  it('requires a name', () => {
    expect(validateSeriesValues({ ...valid, name: '  ' }, 'create').errors.name).toBe(
      'Enter a series name.',
    );
  });

  it('requires a niche', () => {
    expect(
      validateSeriesValues({ ...valid, 'niche.subject': ' ' }, 'create').errors['niche.subject'],
    ).toBe('Enter a niche.');
  });

  it('holds the PRD duration range of 10-180 s (R-009-1)', () => {
    const message = 'Target duration must be a whole number of seconds from 10 to 180.';
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe(message);
    expect(
      validateSeriesValues({ ...valid, target_duration_s: 'abc' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe(message);
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '9' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe(message);
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '181' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe(message);
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '75.5' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBeDefined();
    expect(validateSeriesValues({ ...valid, target_duration_s: '10' }, 'create').errors).toEqual(
      {},
    );
    expect(validateSeriesValues({ ...valid, target_duration_s: '180' }, 'create').errors).toEqual(
      {},
    );
  });

  it('requires an explicit mode and offers no silent default (R-027-1)', () => {
    expect(validateSeriesValues({ ...valid, mode: '' }, 'create').errors.mode).toBe(
      'Choose factual or creative.',
    );
    expect(validateSeriesValues({ ...valid, mode: 'other' }, 'create').errors.mode).toBe(
      'Choose factual or creative.',
    );
  });

  it('allows a blank voice id, which means the environment default', () => {
    expect(
      validateSeriesValues({ ...valid, 'voice_config.voice_id': '' }, 'create').errors,
    ).toEqual({});
  });

  it('guards an emptied language on create but not on edit (legacy profiles)', () => {
    expect(
      validateSeriesValues({ ...valid, narration_language: '' }, 'create').errors[
        'narration_language'
      ],
    ).toBe('Enter a language.');
    expect(
      validateSeriesValues({ ...valid, narration_language: '' }, 'edit').errors[
        'narration_language'
      ],
    ).toBeUndefined();
  });

  it('rejects an aspect ratio outside the two documented frames', () => {
    expect(
      validateSeriesValues({ ...valid, default_aspect_ratio: '3:2' }, 'create').errors[
        'default_aspect_ratio'
      ],
    ).toBe('Choose 9:16 or 4:5.');
  });

  it('requires a positive numeric voice speed', () => {
    expect(
      validateSeriesValues({ ...valid, 'voice_config.speed': '0' }, 'create').errors[
        'voice_config.speed'
      ],
    ).toBe('Enter a speed greater than 0.');
    expect(
      validateSeriesValues({ ...valid, 'voice_config.speed': 'fast' }, 'create').errors[
        'voice_config.speed'
      ],
    ).toBe('Enter a number.');
  });

  it('returns the profile it validated so the caller never rebuilds it', () => {
    const result = validateSeriesValues(valid, 'create');
    expect(result.profile?.mode).toBe('creative');
    expect(result.profile?.target_duration_s).toBe(75);
    expect(result.profile?.narration_language).toBe('en');
  });
});

describe('derived slug edge cases', () => {
  const base: Record<string, string> = {
    name: 'Nick and Grace',
    'niche.subject': 'Flatmates who fix things badly',
    target_duration_s: '75',
    narration_language: 'en',
    mode: 'creative',
  };

  it('derives a valid slug from punctuation and accents', () => {
    expect(deriveSlug('Nick & Grace!')).toBe('nick-grace');
    expect(deriveSlug('Café Société')).toBe('cafe-societe');
    expect(deriveSlug('  Spaced   Out  ')).toBe('spaced-out');
  });

  it('rejects a name that cannot produce a slug', () => {
    // The slug is derived, so a name of pure punctuation fails the API's slug
    // rule. That failure must land on the name, where the owner can fix it.
    const result = validateSeriesValues({ ...base, name: '🦄🦄' }, 'create');
    expect(result.errors['name']).toContain('at least one letter or number');
  });

  it('accepts an ordinary name', () => {
    expect(validateSeriesValues(base, 'create').errors['name']).toBeUndefined();
  });
});

describe('videos per batch', () => {
  const base: Record<string, string> = {
    name: 'The Art of Seduction',
    'niche.subject': 'Female psychology',
    target_duration_s: '75',
    videos_per_batch: '5',
    narration_language: 'en',
    mode: 'creative',
  };

  it('defaults to one video', () => {
    const defaults = profileToValues(SeriesProfileSchema.parse(defaultProfile()));
    expect(defaults['videos_per_batch']).toBe('1');
  });

  it('carries the chosen count into the stored profile', () => {
    const profile = valuesToProfile(base, null);
    expect(profile['videos_per_batch']).toBe(5);
  });

  it('refuses a count outside 1 to 30', () => {
    for (const bad of ['0', '31', '', 'many']) {
      const result = validateSeriesValues({ ...base, videos_per_batch: bad }, 'create');
      expect(result.errors['videos_per_batch']).toBeDefined();
    }
  });

  it('accepts the range edges', () => {
    for (const ok of ['1', '30']) {
      const result = validateSeriesValues({ ...base, videos_per_batch: ok }, 'create');
      expect(result.errors['videos_per_batch']).toBeUndefined();
    }
  });
});
