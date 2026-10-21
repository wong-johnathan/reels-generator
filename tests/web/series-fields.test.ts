import { describe, expect, it } from 'vitest';

import { SeriesProfileSchema, SeriesVersionDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  BLOCKS,
  FIELDS,
  FIELD_BY_PATH,
  changedFields,
  profileToValues,
  validateSeriesValues,
  valuesFromForm,
  valuesToProfile,
} from '../../src/web/series/fields.js';

/**
 * S-04 field model (UX_SPEC A-4: five blocks — identity & niche, voice &
 * narration, art & references, output, mode) and R-002-1: every save is a
 * version mint, so the form must be able to say exactly which fields changed.
 *
 * These are the pure rules the server renderer and the client enhancer share;
 * no DOM, no network, no provider.
 */

const profile = SeriesProfileSchema.parse(
  SeriesVersionDetailSchema.parse(FIXTURES['series.versions.get']).snapshot,
);

describe('the five field blocks (UX_SPEC A-4)', () => {
  it('renders identity, voice, art, output and mode in that order', () => {
    expect(BLOCKS.map((block) => block.title)).toEqual([
      'Identity & niche',
      'Voice & narration',
      'Art & references',
      'Output',
      'Mode',
    ]);
    expect(BLOCKS.map((block) => block.id)).toEqual(['identity', 'voice', 'art', 'output', 'mode']);
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
      'narration_language',
      'image_resolution',
      'mode',
    ]) {
      expect(paths.has(path), path).toBe(true);
    }
  });

  it('keeps the series-level fields out of the version snapshot', () => {
    expect(FIELD_BY_PATH.has('slug')).toBe(true);
    // Name and slug live on the series row, not inside the version snapshot.
    expect(profile).not.toHaveProperty('name');
    expect(profile).not.toHaveProperty('slug');
  });
});

describe('profile <-> form values', () => {
  it('flattens the fixture profile into the form, one line per list item', () => {
    const values = profileToValues(profile);
    expect(values['niche.subject']).toBe('psychology for founders');
    expect(values['niche.boundaries']).toBe('no medical advice');
    expect(values['niche.prohibited_topics']).toBe('politics');
    expect(values['script_style.structure']).toBe('hook\ntension\nturn\nlanding');
    expect(values['voice_config.speed']).toBe('1');
    expect(values['art_style.recurring_protagonist']).toBe('true');
    expect(values['default_aspect_ratio']).toBe('9:16');
    expect(values['target_duration_s']).toBe('75');
    expect(values.mode).toBe('creative');
  });

  it('round-trips the profile through the form without losing a value', () => {
    const rebuilt = valuesToProfile(profileToValues(profile), profile);
    expect(rebuilt).toEqual(profile);
    expect(SeriesProfileSchema.parse(rebuilt)).toEqual(profile);
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
      slug: 'new-series',
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
    expect(parsed.niche).toMatchObject({ subject: 'psychology' });
    expect(parsed.music_config).toBeNull();
  });

  it('normalises an absent checkbox and ignores unknown form keys', () => {
    const values = valuesFromForm({
      name: 'New series',
      'art_style.recurring_protagonist': 'on',
      'not.a.field': 'ignored',
    });
    expect(values['art_style.recurring_protagonist']).toBe('true');
    expect(values).not.toHaveProperty('not.a.field');
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
        block: 'voice',
        blockTitle: 'Voice & narration',
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

describe('validation (R-001-1, R-009-1, R-027-1)', () => {
  const valid = valuesFromForm({
    name: 'Founders, Quietly',
    slug: 'founders-quietly',
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

  it('requires a lower-case hyphenated slug on create only', () => {
    expect(validateSeriesValues({ ...valid, slug: 'Not A Slug' }, 'create').errors.slug).toBe(
      'Use lower-case words separated by single hyphens, like founders-quietly.',
    );
    expect(validateSeriesValues({ ...valid, slug: '' }, 'edit').errors.slug).toBeUndefined();
  });

  it('holds the PRD duration range of 10-180 s (R-009-1)', () => {
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '9' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe('Target duration must be a whole number of seconds from 10 to 180.');
    expect(
      validateSeriesValues({ ...valid, target_duration_s: '181' }, 'create').errors[
        'target_duration_s'
      ],
    ).toBe('Target duration must be a whole number of seconds from 10 to 180.');
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
  });
});
