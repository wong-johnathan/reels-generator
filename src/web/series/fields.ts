/**
 * S-04 field model — the five profile blocks (UX_SPEC A-4), the flattening
 * between the contract's jsonb profile and the form, the changed-field diff
 * that the IP-02 commit panel reports, and the validation the route applies
 * before a version is minted.
 *
 * Pure: no DOM, no network, no database. The server renderer and the client
 * enhancer import this same module, so a live edit and a re-rendered page
 * cannot disagree about what changed.
 */
import type { z } from 'zod';

import type { SeriesProfileSchema } from '../../../contract/api.js';

export type SeriesProfile = z.infer<typeof SeriesProfileSchema>;

export type BlockId = 'identity' | 'voice' | 'art' | 'output' | 'mode';

export interface Block {
  readonly id: BlockId;
  readonly title: string;
}

/** UX_SPEC A-4 names these five blocks in this order. */
export const BLOCKS: readonly Block[] = [
  { id: 'identity', title: 'Identity & niche' },
  { id: 'voice', title: 'Voice & narration' },
  { id: 'art', title: 'Art & references' },
  { id: 'output', title: 'Output' },
  { id: 'mode', title: 'Mode' },
];

export type FieldKind = 'text' | 'textarea' | 'lines' | 'number' | 'checkbox' | 'select' | 'radio';

export interface FieldOption {
  readonly value: string;
  readonly label: string;
  readonly helper: string;
}

export interface FieldSpec {
  readonly path: string;
  readonly label: string;
  readonly block: BlockId;
  readonly kind: FieldKind;
  /** Visible helper below the control (UC-19: helper, never a placeholder). */
  readonly helper: string;
  /** False for the series-row fields (name, slug) that the snapshot excludes. */
  readonly profile?: false;
  /** Textarea rows for the multi-line kinds. */
  readonly rows?: number;
  readonly options?: readonly FieldOption[];
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly required?: boolean;
}

/** R-009-1: range 10–180 s, recommended ceiling ≤90 s, default 75 s. */
export const MIN_DURATION_S = 10;
export const MAX_DURATION_S = 180;

const LINES_HELPER = 'One item per line.';

export const FIELDS: readonly FieldSpec[] = [
  // ── Identity & niche ────────────────────────────────────────────────────
  {
    path: 'name',
    label: 'Series name',
    block: 'identity',
    kind: 'text',
    profile: false,
    required: true,
    helper: 'Shown in the rail and on every batch and export row of this series.',
  },
  {
    path: 'slug',
    label: 'Slug',
    block: 'identity',
    kind: 'text',
    profile: false,
    required: true,
    helper: 'Lower-case words separated by single hyphens, like founders-quietly.',
  },
  {
    path: 'niche.subject',
    label: 'Subject',
    block: 'identity',
    kind: 'text',
    helper: 'What the series is about. Used to propose topics and draft scripts.',
  },
  {
    path: 'niche.audience',
    label: 'Audience',
    block: 'identity',
    kind: 'text',
    helper: 'Who the scripts are written for.',
  },
  {
    path: 'niche.boundaries',
    label: 'Boundaries',
    block: 'identity',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Content the series must not cross.',
  },
  {
    path: 'niche.language',
    label: 'Language',
    block: 'identity',
    kind: 'text',
    helper: 'Language code for the niche, like en.',
  },
  {
    path: 'niche.location',
    label: 'Location',
    block: 'identity',
    kind: 'text',
    helper: 'Geographic focus, or global.',
  },
  {
    path: 'niche.prohibited_topics',
    label: 'Prohibited topics',
    block: 'identity',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Topics the series must refuse.',
  },
  {
    path: 'niche.preferred_sources',
    label: 'Preferred sources',
    block: 'identity',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Research prefers these sources.',
  },
  {
    path: 'script_style.tone',
    label: 'Tone',
    block: 'identity',
    kind: 'text',
    helper: 'How the narration should read.',
  },
  {
    path: 'script_style.structure',
    label: 'Structure',
    block: 'identity',
    kind: 'lines',
    rows: 4,
    helper: 'One item per line, in order.',
  },
  // ── Voice & narration ───────────────────────────────────────────────────
  {
    path: 'voice_config.voice_id',
    label: 'Voice',
    block: 'voice',
    kind: 'text',
    helper: 'Provider voice identifier used for narration.',
  },
  {
    path: 'voice_config.speed',
    label: 'Speed',
    block: 'voice',
    kind: 'number',
    step: 0.01,
    helper: 'Playback speed multiplier.',
  },
  {
    path: 'voice_config.style',
    label: 'Voice style',
    block: 'voice',
    kind: 'text',
    helper: 'Delivery note passed to the voice provider.',
  },
  {
    path: 'narration_language',
    label: 'Narration language',
    block: 'voice',
    kind: 'text',
    helper: 'Language code for narration and captions.',
  },
  // ── Art & references ────────────────────────────────────────────────────
  {
    path: 'art_style.preset',
    label: 'Art preset',
    block: 'art',
    kind: 'text',
    helper: 'Image style preset used for scene art.',
  },
  {
    path: 'art_style.palette',
    label: 'Palette',
    block: 'art',
    kind: 'text',
    helper: 'Colour direction for scene art.',
  },
  {
    path: 'art_style.recurring_protagonist',
    label: 'Recurring protagonist',
    block: 'art',
    kind: 'checkbox',
    helper: 'When set, scene art keeps the same protagonist across scenes.',
  },
  // ── Output ──────────────────────────────────────────────────────────────
  {
    path: 'default_aspect_ratio',
    label: 'Aspect ratio',
    block: 'output',
    kind: 'select',
    options: [
      { value: '9:16', label: '9:16 — 1080×1920', helper: '' },
      { value: '4:5', label: '4:5', helper: '' },
    ],
    helper: '9:16 is the default (1080×1920).',
  },
  {
    path: 'target_duration_s',
    label: 'Target duration',
    block: 'output',
    kind: 'number',
    min: MIN_DURATION_S,
    max: MAX_DURATION_S,
    step: 1,
    unit: 's',
    helper: '10–180 s. The default is 75 s.',
  },
  {
    path: 'image_resolution',
    label: 'Image resolution',
    block: 'output',
    kind: 'select',
    options: [
      { value: '1K', label: '1K', helper: '' },
      { value: '2K', label: '2K', helper: '' },
    ],
    helper: '1K is the default (768×1376).',
  },
  // ── Mode ────────────────────────────────────────────────────────────────
  {
    path: 'mode',
    label: 'Mode',
    block: 'mode',
    kind: 'radio',
    options: [
      {
        value: 'factual',
        label: 'Factual',
        helper:
          'Factual mode: every claim must resolve to a source before a script can be approved.',
      },
      {
        value: 'creative',
        label: 'Creative',
        helper:
          'Creative mode — citation enforcement does not apply. The mode is recorded in the ' +
          'export manifest.',
      },
    ],
    helper: 'Mode is stored on the version and cannot be changed by an existing project.',
  },
];

export const FIELD_BY_PATH: ReadonlyMap<string, FieldSpec> = new Map(
  FIELDS.map((field) => [field.path, field] as const),
);

export function blockTitle(id: BlockId): string {
  const block = BLOCKS.find((candidate) => candidate.id === id);
  return block === undefined ? id : block.title;
}

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

/** One flat, string-valued map for the whole form (checkbox: 'true'/'false'). */
export type SeriesValues = Readonly<Record<string, string>>;

export function normaliseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) current[last] = value;
}

function valueFromProfile(field: FieldSpec, raw: unknown): string {
  if (raw === null || raw === undefined) {
    return field.kind === 'checkbox' ? 'false' : '';
  }
  if (field.kind === 'lines') {
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item)).join('\n');
    }
    return String(raw);
  }
  if (field.kind === 'checkbox') return raw === true ? 'true' : 'false';
  return String(raw);
}

/** A blank profile that still satisfies the contract's required keys. */
export function defaultProfile(): Record<string, unknown> {
  return {
    niche: {
      subject: '',
      audience: '',
      boundaries: [],
      language: '',
      location: '',
      prohibited_topics: [],
      preferred_sources: [],
    },
    script_style: { tone: '', structure: [] },
    voice_config: { voice_id: '', speed: 1, style: '' },
    art_style: { preset: '', palette: '', recurring_protagonist: false },
    default_aspect_ratio: '9:16',
    target_duration_s: 75,
    narration_language: '',
    captions_preset: null,
    music_config: null,
    image_resolution: '1K',
    mode: '',
  };
}

export function profileToValues(profile: SeriesProfile): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of FIELDS) {
    values[field.path] =
      field.profile === false
        ? ''
        : valueFromProfile(
            field,
            getPath(profile as unknown as Record<string, unknown>, field.path),
          );
  }
  return values;
}

/**
 * Only the known field paths survive; an absent checkbox means false. The
 * output block starts from the product defaults (9:16, 75 s, 1K) so a form
 * that does not submit a select still yields a complete profile.
 */
export function valuesFromForm(fields: Readonly<Record<string, string>>): Record<string, string> {
  const values: Record<string, string> = profileToValues(
    defaultProfile() as unknown as SeriesProfile,
  );
  for (const field of FIELDS) {
    const raw = fields[field.path];
    if (raw === undefined) continue;
    values[field.path] =
      field.kind === 'checkbox'
        ? raw === 'on' || raw === 'true' || raw === '1'
          ? 'true'
          : 'false'
        : raw;
  }
  return values;
}

function valueForProfile(field: FieldSpec, value: string): unknown {
  switch (field.kind) {
    case 'lines':
      return normaliseLines(value);
    case 'checkbox':
      return value === 'true';
    case 'number':
      return value.trim() === '' ? 0 : Number(value);
    default:
      return value;
  }
}

/**
 * Rebuild the profile from the form. `base` supplies everything the form does
 * not edit — captions, music and any key this UI does not know about — so an
 * edit never silently drops data from the immutable snapshot.
 */
export function valuesToProfile(
  values: SeriesValues,
  base: SeriesProfile | Record<string, unknown> | null,
): Record<string, unknown> {
  const profile =
    base === null ? defaultProfile() : (structuredClone(base) as Record<string, unknown>);
  for (const field of FIELDS) {
    if (field.profile === false) continue;
    setPath(profile, field.path, valueForProfile(field, values[field.path] ?? ''));
  }
  return profile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Changed fields
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangedField {
  readonly path: string;
  readonly label: string;
  readonly block: BlockId;
  readonly blockTitle: string;
  readonly from: string;
  readonly to: string;
}

function comparisonKey(field: FieldSpec, value: string): string {
  if (field.kind === 'lines') return normaliseLines(value).join('\n');
  if (field.kind === 'checkbox') return value === 'true' ? 'true' : 'false';
  return value;
}

function displayValue(field: FieldSpec, value: string): string {
  switch (field.kind) {
    case 'lines': {
      const lines = normaliseLines(value);
      return lines.length === 0 ? '(empty)' : lines.join(', ');
    }
    case 'checkbox':
      return value === 'true' ? 'yes' : 'no';
    default: {
      const trimmed = value.trim();
      return trimmed.length === 0 ? '(empty)' : trimmed;
    }
  }
}

/** Form order, never map order — the summary reads top to bottom like the form. */
export function changedFields(before: SeriesValues, after: SeriesValues): ChangedField[] {
  const changes: ChangedField[] = [];
  for (const field of FIELDS) {
    const from = before[field.path] ?? '';
    const to = after[field.path] ?? '';
    if (comparisonKey(field, from) === comparisonKey(field, to)) continue;
    changes.push({
      path: field.path,
      label: field.label,
      block: field.block,
      blockTitle: blockTitle(field.block),
      from: displayValue(field, from),
      to: displayValue(field, to),
    });
  }
  return changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ValidationResult {
  readonly errors: Readonly<Record<string, string>>;
  /** Null whenever any field failed, so a caller cannot save an invalid profile. */
  readonly profile: Record<string, unknown> | null;
}

export function validateSeriesValues(
  values: SeriesValues,
  mode: 'create' | 'edit',
  base: SeriesProfile | Record<string, unknown> | null = null,
): ValidationResult {
  const errors: Record<string, string> = {};

  if ((values['name'] ?? '').trim().length === 0) {
    errors['name'] = 'Enter a series name.';
  }

  const slug = (values['slug'] ?? '').trim();
  if (mode === 'create' && !SLUG_PATTERN.test(slug)) {
    errors['slug'] = 'Use lower-case words separated by single hyphens, like founders-quietly.';
  }

  const duration = (values['target_duration_s'] ?? '').trim();
  if (!/^\d+$/.test(duration)) {
    errors['target_duration_s'] =
      'Target duration must be a whole number of seconds from 10 to 180.';
  } else {
    const seconds = Number(duration);
    if (seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) {
      errors['target_duration_s'] =
        'Target duration must be a whole number of seconds from 10 to 180.';
    }
  }

  const seriesMode = values['mode'] ?? '';
  if (seriesMode !== 'factual' && seriesMode !== 'creative') {
    errors['mode'] = 'Choose factual or creative.';
  }

  const aspect = values['default_aspect_ratio'] ?? '';
  if (aspect !== '9:16' && aspect !== '4:5') {
    errors['default_aspect_ratio'] = 'Choose 9:16 or 4:5.';
  }

  const resolution = values['image_resolution'] ?? '';
  if (resolution !== '1K' && resolution !== '2K') {
    errors['image_resolution'] = 'Choose 1K or 2K.';
  }

  const speed = (values['voice_config.speed'] ?? '').trim();
  if (speed.length === 0 || !Number.isFinite(Number(speed))) {
    errors['voice_config.speed'] = 'Enter a number.';
  } else if (Number(speed) <= 0) {
    errors['voice_config.speed'] = 'Enter a speed greater than 0.';
  }

  return {
    errors,
    profile: Object.keys(errors).length === 0 ? valuesToProfile(values, base) : null,
  };
}

/**
 * A new profile is ready to submit once it has a name, a slug and an explicit
 * mode (IP-02's "nothing to save" state; R-027-1 forbids a silent default).
 */
export function createReady(values: SeriesValues): boolean {
  const mode = values['mode'] ?? '';
  return (
    (values['name'] ?? '').trim().length > 0 &&
    (values['slug'] ?? '').trim().length > 0 &&
    (mode === 'factual' || mode === 'creative')
  );
}
