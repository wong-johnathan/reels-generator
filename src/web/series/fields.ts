/**
 * S-04 field model — the collapsed primary form plus the Advanced defaults,
 * the flattening between the contract's jsonb profile and the form, the
 * changed-field diff that the IP-02 commit panel reports, and the validation
 * the route applies before a version is minted.
 *
 * The operator sees seven primary inputs (name, niche, example script,
 * duration, language, voice id, art style) and a factual/creative mode radio;
 * every other profile leaf lives in a single collapsed "Advanced (defaults are
 * fine)" block so nothing is lost but the common case stays short. The slug is
 * derived from the name rather than asked for, because a slug is a lossy,
 * machine-friendly echo of the name and asking for both invites disagreement.
 *
 * Pure: no DOM, no network, no database. The server renderer and the client
 * enhancer import this same module, so a live edit and a re-rendered page
 * cannot disagree about what changed.
 */
import type { z } from 'zod';

import type { SeriesProfileSchema } from '../../../contract/api.js';

export type SeriesProfile = z.infer<typeof SeriesProfileSchema>;

export type BlockId = 'primary' | 'mode' | 'advanced';

export interface Block {
  readonly id: BlockId;
  readonly title: string;
}

/** The primary inputs first, then mode, then the collapsed Advanced defaults. */
export const BLOCKS: readonly Block[] = [
  { id: 'primary', title: 'Series' },
  { id: 'mode', title: 'Mode' },
  { id: 'advanced', title: 'Advanced (defaults are fine)' },
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
  /**
   * Value shown when the stored profile predates this field. Without it a
   * profile written before the field existed renders blank, and saving blanks a
   * numeric field to zero — which then fails its own range check.
   */
  readonly initial?: string;
  /** Visible helper below the control (UC-19: helper, never a placeholder). */
  readonly helper: string;
  /** False for the series-row fields (name) that the snapshot excludes. */
  readonly profile?: false;
  /** Textarea rows for the multi-line kinds. */
  readonly rows?: number;
  readonly options?: readonly FieldOption[];
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly required?: boolean;
  /** Omit the key from the profile when the value is blank (optional inputs). */
  readonly omitWhenBlank?: boolean;
}

/** R-009-1: range 10–180 s, recommended ceiling ≤90 s, default 75 s. */
export const MIN_DURATION_S = 10;
export const MAX_DURATION_S = 180;

/** R-019: a batch is up to 30 videos, generated for manual download and upload. */
export const MIN_VIDEOS_PER_BATCH = 1;
export const MAX_VIDEOS_PER_BATCH = 30;

const LINES_HELPER = 'One item per line.';

export const FIELDS: readonly FieldSpec[] = [
  // ── Primary inputs ──────────────────────────────────────────────────────
  {
    path: 'name',
    label: 'Series name',
    block: 'primary',
    kind: 'text',
    profile: false,
    required: true,
    helper: 'Shown in the rail and on every batch and export row of this series.',
  },
  {
    path: 'niche.subject',
    label: 'Niche',
    block: 'primary',
    kind: 'textarea',
    required: true,
    helper: 'What the series is about. This seeds topic proposals and script drafts.',
  },
  {
    path: 'script_style.example_script',
    label: 'Example script',
    block: 'primary',
    kind: 'textarea',
    rows: 6,
    omitWhenBlank: true,
    helper: 'A script you like. The writer matches its shape, pace and voice.',
  },
  {
    path: 'target_duration_s',
    label: 'Duration',
    block: 'primary',
    kind: 'number',
    min: MIN_DURATION_S,
    max: MAX_DURATION_S,
    step: 1,
    unit: 's',
    helper: '10–180 s. The default is 75 s.',
  },
  {
    path: 'videos_per_batch',
    label: 'Videos per batch',
    block: 'primary',
    kind: 'number',
    initial: '1',
    min: MIN_VIDEOS_PER_BATCH,
    max: MAX_VIDEOS_PER_BATCH,
    helper: 'How many videos one batch generates: 1 to 30.',
  },
  {
    path: 'narration_language',
    label: 'Language',
    block: 'primary',
    kind: 'text',
    helper: 'Language code for narration and captions. Pre-filled with en.',
  },
  {
    path: 'voice_config.voice_id',
    label: 'Voice ID',
    block: 'primary',
    kind: 'text',
    helper: "Optional. Blank means 'use ELEVENLABS_VOICE_ID from the environment'.",
  },
  {
    path: 'art_style.preset',
    label: 'Art style',
    block: 'primary',
    kind: 'textarea',
    rows: 3,
    helper: 'Look of the scenes — e.g. clean 2D illustration, flat shading, muted palette.',
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
  // ── Advanced (defaults are fine) ────────────────────────────────────────
  {
    path: 'niche.audience',
    label: 'Audience',
    block: 'advanced',
    kind: 'text',
    helper: 'Who the scripts are written for.',
  },
  {
    path: 'niche.boundaries',
    label: 'Boundaries',
    block: 'advanced',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Content the series must not cross.',
  },
  {
    path: 'niche.language',
    label: 'Niche language',
    block: 'advanced',
    kind: 'text',
    helper: 'Language code for the niche, like en.',
  },
  {
    path: 'niche.location',
    label: 'Location',
    block: 'advanced',
    kind: 'text',
    helper: 'Geographic focus, or global.',
  },
  {
    path: 'niche.prohibited_topics',
    label: 'Prohibited topics',
    block: 'advanced',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Topics the series must refuse.',
  },
  {
    path: 'niche.preferred_sources',
    label: 'Preferred sources',
    block: 'advanced',
    kind: 'lines',
    rows: 3,
    helper: LINES_HELPER + ' Research prefers these sources.',
  },
  {
    path: 'script_style.tone',
    label: 'Tone',
    block: 'advanced',
    kind: 'text',
    helper: 'How the narration should read.',
  },
  {
    path: 'script_style.structure',
    label: 'Structure',
    block: 'advanced',
    kind: 'lines',
    rows: 4,
    helper: 'One item per line, in order.',
  },
  {
    path: 'voice_config.speed',
    label: 'Speed',
    block: 'advanced',
    kind: 'number',
    step: 0.01,
    helper: 'Playback speed multiplier.',
  },
  {
    path: 'voice_config.style',
    label: 'Voice style',
    block: 'advanced',
    kind: 'text',
    helper: 'Delivery note passed to the voice provider.',
  },
  {
    path: 'art_style.palette',
    label: 'Palette',
    block: 'advanced',
    kind: 'text',
    helper: 'Colour direction for scene art.',
  },
  {
    path: 'art_style.recurring_protagonist',
    label: 'Recurring protagonist',
    block: 'advanced',
    kind: 'checkbox',
    helper: 'When set, scene art keeps the same protagonist across scenes.',
  },
  {
    path: 'default_aspect_ratio',
    label: 'Aspect ratio',
    block: 'advanced',
    kind: 'select',
    options: [
      { value: '9:16', label: '9:16 — 1080×1920', helper: '' },
      { value: '4:5', label: '4:5', helper: '' },
    ],
    helper: '9:16 is the default (1080×1920).',
  },
  {
    path: 'image_resolution',
    label: 'Image resolution',
    block: 'advanced',
    kind: 'select',
    options: [
      { value: '1K', label: '1K', helper: '' },
      { value: '2K', label: '2K', helper: '' },
    ],
    helper: '1K is the default (768×1376).',
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

/**
 * The slug for a new series, derived from the name so the operator never has
 * to type one: lower-case, runs of non-alphanumerics collapse to a single
 * hyphen, and leading/trailing hyphens are trimmed. Importing the export
 * module's `slugify` would couple the form to packaging and its 'video' and
 * max-length fallbacks are wrong for a series slug, so the rule lives here.
 */
export function deriveSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
    art_style: { preset: '', palette: '', recurring_protagonist: true },
    default_aspect_ratio: '9:16',
    target_duration_s: 75,
    videos_per_batch: 1,
    narration_language: 'en',
    captions_preset: null,
    music_config: null,
    image_resolution: '1K',
    mode: '',
  };
}

export function profileToValues(profile: SeriesProfile): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of FIELDS) {
    if (field.profile === false) {
      values[field.path] = '';
      continue;
    }
    const stored = getPath(profile as unknown as Record<string, unknown>, field.path);
    values[field.path] =
      stored === undefined || stored === null
        ? (field.initial ?? '')
        : valueFromProfile(field, stored);
  }
  return values;
}

/**
 * Only the known field paths survive; an absent checkbox means its default.
 * The output block starts from the product defaults (9:16, 75 s, 1K, en) so a
 * form that does not submit a control still yields a complete profile.
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
 * edit never silently drops data from the immutable snapshot. Optional inputs
 * marked `omitWhenBlank` leave the stored key untouched rather than writing an
 * empty string, which keeps a blank example script out of the snapshot.
 */
export function valuesToProfile(
  values: SeriesValues,
  base: SeriesProfile | Record<string, unknown> | null,
): Record<string, unknown> {
  const profile =
    base === null ? defaultProfile() : (structuredClone(base) as Record<string, unknown>);
  for (const field of FIELDS) {
    if (field.profile === false) continue;
    const raw = values[field.path] ?? '';
    if (field.omitWhenBlank === true && raw.trim() === '') continue;
    setPath(profile, field.path, valueForProfile(field, raw));
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
// Create summary
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSummaryRow {
  readonly path: string;
  readonly label: string;
  readonly value: string;
}

/**
 * The few inputs that actually define a new series, shown on the create commit
 * bar instead of a diff — a diff would list every pre-filled default (75 s,
 * 9:16, 1K) as a "change", which misleads. The optional inputs (example
 * script, voice id, art style) are deliberately excluded.
 */
const CREATE_SUMMARY_PATHS: readonly string[] = [
  'name',
  'niche.subject',
  'target_duration_s',
  'videos_per_batch',
  'mode',
];

export function createSummary(values: SeriesValues): readonly CreateSummaryRow[] {
  return CREATE_SUMMARY_PATHS.map((path) => {
    const field = FIELD_BY_PATH.get(path);
    return { path, label: field?.label ?? path, value: values[path] ?? '' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

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
  } else if (mode === 'create' && deriveSlug(values['name'] ?? '').length === 0) {
    // The slug is derived, never typed, and the API requires it to look like
    // lower-case words joined by hyphens. A name with no letters or digits —
    // punctuation or emoji only — derives an empty slug, so the failure belongs
    // on the name field with something the owner can act on.
    errors['name'] = 'Use at least one letter or number in the series name.';
  }

  if ((values['niche.subject'] ?? '').trim().length === 0) {
    errors['niche.subject'] = 'Enter a niche.';
  }

  const batchSize = (values['videos_per_batch'] ?? '').trim();
  if (!/^\d+$/.test(batchSize)) {
    errors['videos_per_batch'] = 'Videos per batch must be a whole number from 1 to 30.';
  } else {
    const count = Number(batchSize);
    if (count < MIN_VIDEOS_PER_BATCH || count > MAX_VIDEOS_PER_BATCH) {
      errors['videos_per_batch'] = 'Videos per batch must be a whole number from 1 to 30.';
    }
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

  // The create form pre-fills 'en'; only creation guards against emptying it,
  // because a legacy profile saved before the default existed must stay editable.
  if (mode === 'create' && (values['narration_language'] ?? '').trim().length === 0) {
    errors['narration_language'] = 'Enter a language.';
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
 * A new profile is ready to submit once it has a name, a niche, a whole-number
 * duration in range and an explicit mode (R-027-1 forbids a silent default).
 * The slug no longer gates this — it is derived from the name — and the
 * pre-filled language default is not treated as operator input.
 */
export function createReady(values: SeriesValues): boolean {
  const mode = values['mode'] ?? '';
  const duration = (values['target_duration_s'] ?? '').trim();
  const seconds = /^\d+$/.test(duration) ? Number(duration) : NaN;
  return (
    (values['name'] ?? '').trim().length > 0 &&
    (values['niche.subject'] ?? '').trim().length > 0 &&
    Number.isInteger(seconds) &&
    seconds >= MIN_DURATION_S &&
    seconds <= MAX_DURATION_S &&
    (mode === 'factual' || mode === 'creative')
  );
}
