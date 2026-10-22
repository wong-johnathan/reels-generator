/**
 * The authoring pipeline — US-017 (script draft, reference handling,
 * claim→source mapping) and US-018 (storyboard split).
 *
 * Three boundaries are enforced here, not left to a route handler:
 *
 * 1. **References are stored, never sent** (R-003-3). `buildScriptPrompt()` is the
 *    only place a script request is assembled, and it reads `extracted_style_summary`
 *    and `title` only. `source_text` exists solely for the 8-gram scan (R-003-2).
 *    The 1–5 reference bound and the per-reference rights note (R-003-1/4) are
 *    checked before any provider call, so a bad series profile costs nothing.
 * 2. **A script draft is only a draft when it validated.** `draftScript()` delegates
 *    to `validateWithRetry()`; the malformed path returns the R-004-2 failure and
 *    no content, so nothing downstream can be enqueued from it.
 * 3. **A storyboard must reconstruct the approved narration.** The scene list is
 *    the provider's, but the words are the operator's: concatenating the scenes
 *    must reproduce the approved spoken text exactly (token-wise), scene ids must
 *    stay `S01…Snn`, and the count must fit the target duration (R-009-2). A
 *    provider that paraphrases or drops a sentence is rejected before an image
 *    call, which is what keeps captions and image prompts tied to one script.
 *
 * Every function is pure except `draftScript`, which takes the generation call as
 * a dependency: tests inject a deterministic generator, production injects B-04's
 * text adapter. No provider is reachable from this module on its own.
 */
import type { z } from 'zod';

import {
  TEXT_SCHEMAS,
  type ScriptDocumentSchema,
  type StoryboardDocumentSchema,
} from '../adapters/text-schemas.js';
import {
  DEFAULT_TARGET_DURATION_S,
  NARRATION_WORDS_PER_SECOND,
  wordBudget,
  type WordBudget,
} from '../shared/calibration.js';
import type { CameraMove, SeriesMode } from '../shared/states.js';
import { normaliseWords, scanScript, type EightGramScanResult } from './eight-gram.js';
import { validateWithRetry, type ValidationFailure } from './validation.js';

export type ScriptDocument = z.infer<typeof ScriptDocumentSchema>;
export type StoryboardDocument = z.infer<typeof StoryboardDocumentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// References — R-003-1…4
// ─────────────────────────────────────────────────────────────────────────────

/** R-003-1: the app stores 1–5 references per series. */
export const MIN_REFERENCES = 1;
export const MAX_REFERENCES = 5;

/** A stored series reference. `source_text` never leaves the server (R-003-3). */
export interface SeriesReference {
  readonly id: string;
  readonly title: string;
  /** Stored only so the 8-gram scan has something to compare against. */
  readonly source_text: string;
  /** Editable by the operator (R-003-1). The only reference text a prompt may use. */
  readonly extracted_style_summary: string;
  /** R-003-4: origin/rights note, stored per reference. */
  readonly rights_note: string;
}

export type ReferenceSetErrorCode =
  | 'too_few'
  | 'too_many'
  | 'duplicate_id'
  | 'missing_source_text'
  | 'missing_style_summary'
  | 'missing_rights_note';

export class ReferenceSetError extends Error {
  constructor(
    readonly code: ReferenceSetErrorCode,
    readonly reference_id: string | null,
    detail: string,
  ) {
    super(detail);
    this.name = 'ReferenceSetError';
  }
}

/**
 * The pre-flight check for R-003-1/4 and R-003-2's precondition. Throws rather
 * than returning false so a caller cannot fall through to a provider call.
 */
export function assertReferenceSet(references: readonly SeriesReference[]): void {
  if (references.length < MIN_REFERENCES) {
    throw new ReferenceSetError(
      'too_few',
      null,
      `a script needs at least ${MIN_REFERENCES} reference with an extracted style summary (R-003-1); got ${references.length}`,
    );
  }
  if (references.length > MAX_REFERENCES) {
    throw new ReferenceSetError(
      'too_many',
      null,
      `at most ${MAX_REFERENCES} references are supported (R-003-1); got ${references.length}`,
    );
  }

  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.id)) {
      throw new ReferenceSetError(
        'duplicate_id',
        reference.id,
        `reference ${reference.id} appears more than once (R-003-1)`,
      );
    }
    seen.add(reference.id);
    if (reference.source_text.trim().length === 0) {
      throw new ReferenceSetError(
        'missing_source_text',
        reference.id,
        `reference ${reference.id} has no stored source text to scan against (R-003-2)`,
      );
    }
    if (reference.extracted_style_summary.trim().length === 0) {
      throw new ReferenceSetError(
        'missing_style_summary',
        reference.id,
        `reference ${reference.id} has no extracted style summary (R-003-1)`,
      );
    }
    if (reference.rights_note.trim().length === 0) {
      throw new ReferenceSetError(
        'missing_rights_note',
        reference.id,
        `reference ${reference.id} has no rights note (R-003-4)`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Script request — R-003-3, R-004-1
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptSeriesProfile {
  readonly mode: SeriesMode;
  readonly niche?: string | null;
  readonly tone?: string | null;
  readonly structure?: string | null;
}

export interface ScriptTopicInput {
  readonly title: string;
  readonly description: string;
  readonly rationale?: string | null;
}

export interface ScriptPromptClaim {
  readonly text: string;
  readonly is_factual: boolean;
}

export interface ScriptPromptInput {
  readonly series: ScriptSeriesProfile;
  readonly topic: ScriptTopicInput;
  readonly references: readonly SeriesReference[];
  readonly target_duration_s?: number;
  readonly claims?: readonly ScriptPromptClaim[];
}

export interface ScriptPrompt {
  readonly stage: 'SC';
  readonly schema_name: 'script';
  readonly schema_version: string;
  readonly series_mode: SeriesMode;
  readonly reference_ids: readonly string[];
  readonly word_budget: WordBudget;
  readonly messages: readonly {
    readonly role: 'system' | 'user';
    readonly content: string;
  }[];
}

function bullet(label: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : `- ${label}: ${trimmed}`;
}

/**
 * Assemble the SC request. The style section is built from summaries and titles;
 * `source_text` is not reachable from this function, so R-003-3 holds by
 * construction rather than by a redaction pass.
 */
export function buildScriptPrompt(input: ScriptPromptInput): ScriptPrompt {
  assertReferenceSet(input.references);

  const targetDuration = input.target_duration_s ?? DEFAULT_TARGET_DURATION_S;
  const budget = wordBudget(targetDuration);
  const targetScenes = targetSceneCount(targetDuration);
  const wordsPerScene = Math.max(1, Math.round(budget.target_words / targetScenes));
  const wordsPerSentence = Math.max(1, Math.round(NARRATION_WORDS_PER_SECOND * 4.4));
  const scriptSentences = Math.max(1, Math.round(budget.target_words / wordsPerSentence));

  const seriesLines = [
    `- mode: ${input.series.mode}`,
    bullet('niche', input.series.niche),
    bullet('tone', input.series.tone),
    bullet('structure', input.series.structure),
  ].filter((line): line is string => line !== null);

  const topicLines = [
    `- title: ${input.topic.title}`,
    `- description: ${input.topic.description}`,
    bullet('rationale', input.topic.rationale),
  ].filter((line): line is string => line !== null);

  const styleLines = input.references.map(
    (reference) => `- ${reference.title}: ${reference.extracted_style_summary}`,
  );

  const claimLines =
    input.series.mode === 'factual'
      ? (input.claims ?? []).filter((claim) => claim.is_factual).map((claim) => `- ${claim.text}`)
      : [];

  const sections = [
    'SERIES',
    seriesLines.join('\n'),
    '',
    'TOPIC',
    topicLines.join('\n'),
    '',
    'STYLE REFERENCES (extracted summaries only — never the source text)',
    styleLines.join('\n'),
    ...(claimLines.length > 0 ? ['', 'FACTUAL CLAIMS TO COVER', claimLines.join('\n')] : []),
    '',
    'LENGTH',
    `- target ${budget.target_words} words for ${targetDuration} s at ${NARRATION_WORDS_PER_SECOND} words/s; acceptable ${budget.min_words}–${budget.max_words} words`,
    // A bare number is not something a model can hit. Give it countable units and
    // require the check: the same request produced 136 words for a 228-word target
    // while 'target 228 words' sat in the prompt unread.
    `- that is about ${scriptSentences} spoken sentences of ${wordsPerSentence} words each`,
    `- the storyboard will split it into about ${targetScenes} scenes, so each scene carries roughly ${wordsPerScene} words of narration`,
    `- COUNT the words in \`narration\` before you answer. If it is below ${budget.min_words} or above ${budget.max_words}, rewrite it before returning the JSON.`,
    '- being short is the failure mode here, not being long: a short script cannot fill the video and is rejected',
    '',
    'PUNCTUATION',
    '- Never use an em dash (—) or an en dash (–) anywhere in the script.',
    '- They force the voice to pause mid-sentence, which stretches the runtime and reads as hesitation.',
    '- Use a comma, a colon or a full stop instead.',
    '',
    `JSON SCHEMA ${TEXT_SCHEMAS.script.version}`,
    JSON.stringify(TEXT_SCHEMAS.script.jsonSchema),
  ];

  return {
    stage: 'SC',
    schema_name: 'script',
    schema_version: TEXT_SCHEMAS.script.version,
    series_mode: input.series.mode,
    reference_ids: input.references.map((reference) => reference.id),
    word_budget: budget,
    messages: [
      {
        role: 'system',
        content:
          'You write short-form narration for a faceless video series. Reply with one JSON object and ' +
          `nothing else. It must validate against ${TEXT_SCHEMAS.script.version} ` +
          '({hook, narration, ending, title, description, hashtags}). Use the style summaries for tone; ' +
          'never quote or paraphrase the reference source text, which you are not given.',
      },
      { role: 'user', content: sections.join('\n') },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Word budget — R-009-2/3
// ─────────────────────────────────────────────────────────────────────────────

export interface WordBudgetCheck {
  readonly word_count: number;
  readonly estimated_runtime_s: number;
  readonly budget: WordBudget;
  readonly within_band: boolean;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * R-009-2/3's budget check. Out-of-band narration is a warning the operator
 * must see (UI_SPEC S-10, C-11), not a hard failure: the script is still a valid
 * document, and the duration band is re-checked against real narration in TC.
 */
export function checkWordBudget(
  narration: string,
  targetDurationS: number = DEFAULT_TARGET_DURATION_S,
): WordBudgetCheck {
  const wordCount = countWords(narration);
  const budget = wordBudget(targetDurationS);
  return {
    word_count: wordCount,
    estimated_runtime_s: Number((wordCount / NARRATION_WORDS_PER_SECOND).toFixed(3)),
    budget,
    within_band: wordCount >= budget.min_words && wordCount <= budget.max_words,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim → source mapping — R-014-1, R-027
// ─────────────────────────────────────────────────────────────────────────────

/** QUALIFICATION §3: only sources at or above this rerank score are offered. */
export const RESEARCH_ACCEPTANCE_SCORE = 1.5;

export interface ClaimInput {
  readonly text: string;
  readonly is_factual: boolean;
  /** The operator's (or the model's) chosen source, if any. */
  readonly source_id?: string | null;
}

export interface SourceInput {
  readonly id: string;
  readonly url: string;
  readonly title?: string | null;
  readonly retrieved_at?: string | null;
  readonly rerank_score: number;
  readonly status?: 'accepted' | 'rejected';
}

export type MappedClaimStatus = 'sourced' | 'url_unreachable' | 'unsourced' | 'non_factual';

export interface ClaimSourceRow {
  readonly claim_text: string;
  readonly is_factual: boolean;
  readonly status: MappedClaimStatus;
  readonly source_id: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly retrieved_at: string | null;
  readonly rerank_score: number | null;
}

/** One row of the exported `manifest.csv` (TECH_DESIGN §8.3). */
export interface ClaimSourceManifestRow {
  readonly claim_text: string;
  readonly url: string;
  readonly retrieved_at: string | null;
  readonly status: 'sourced';
}

export interface ClaimMapping {
  readonly mode: SeriesMode;
  readonly rows: readonly ClaimSourceRow[];
  readonly unresolved: readonly ClaimSourceRow[];
  readonly all_resolved: boolean;
  readonly manifest_rows: readonly ClaimSourceManifestRow[];
}

/** TECH_DESIGN §3.2 invariant: accepted means rerank ≥ 1.5 and a non-empty URL. */
export function isAcceptedSource(source: SourceInput): boolean {
  return (
    (source.status ?? 'accepted') === 'accepted' &&
    source.rerank_score >= RESEARCH_ACCEPTANCE_SCORE &&
    source.url.trim().length > 0
  );
}

/**
 * Map each claim to its source. A factual claim is only `sourced` when it points
 * at an accepted source; everything else is left visibly unresolved so approval
 * can be blocked (R-027-3) instead of silently passing. Creative mode records no
 * citation rows at all (R-027-4).
 */
export function mapClaimsToSources(
  claims: readonly ClaimInput[],
  sources: readonly SourceInput[],
  options: { readonly mode: SeriesMode },
): ClaimMapping {
  if (options.mode === 'creative') {
    return {
      mode: 'creative',
      rows: [],
      unresolved: [],
      all_resolved: true,
      manifest_rows: [],
    };
  }

  const byId = new Map(sources.map((source) => [source.id, source] as const));
  const rows: ClaimSourceRow[] = claims.map((claim) => {
    const base = {
      claim_text: claim.text,
      is_factual: claim.is_factual,
    } as const;

    if (!claim.is_factual) {
      return {
        ...base,
        status: 'non_factual',
        source_id: null,
        url: null,
        title: null,
        retrieved_at: null,
        rerank_score: null,
      };
    }

    const sourceId = claim.source_id ?? null;
    if (sourceId === null) {
      return {
        ...base,
        status: 'unsourced',
        source_id: null,
        url: null,
        title: null,
        retrieved_at: null,
        rerank_score: null,
      };
    }

    const source = byId.get(sourceId);
    if (source === undefined || !isAcceptedSource(source)) {
      return {
        ...base,
        status: 'url_unreachable',
        source_id: sourceId,
        url: source?.url ?? null,
        title: source?.title ?? null,
        retrieved_at: source?.retrieved_at ?? null,
        rerank_score: source?.rerank_score ?? null,
      };
    }

    return {
      ...base,
      status: 'sourced',
      source_id: source.id,
      url: source.url,
      title: source.title ?? null,
      retrieved_at: source.retrieved_at ?? null,
      rerank_score: source.rerank_score,
    };
  });

  const unresolved = rows.filter((row) => row.status !== 'sourced' && row.status !== 'non_factual');

  const manifestRows: ClaimSourceManifestRow[] = [];
  for (const row of rows) {
    if (row.status !== 'sourced' || row.url === null) continue;
    manifestRows.push({
      claim_text: row.claim_text,
      url: row.url,
      retrieved_at: row.retrieved_at,
      status: 'sourced',
    });
  }

  return {
    mode: 'factual',
    rows,
    unresolved,
    all_resolved: unresolved.length === 0,
    manifest_rows: manifestRows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storyboard split — US-018, R-009-2
// ─────────────────────────────────────────────────────────────────────────────

/** R-009-2's reference point: a 75 s video uses ~17 scenes (TECH_DESIGN §1). */
export const SCENE_REFERENCE_DURATION_S = DEFAULT_TARGET_DURATION_S;
export const SCENE_REFERENCE_COUNT = 17;

/** `scene_no` is `S01…S99`; the scene count can never exceed the id space. */
export const MAX_SCENES = 99;

function assertDuration(targetDurationS: number): void {
  if (!Number.isFinite(targetDurationS) || targetDurationS <= 0) {
    throw new RangeError(
      `target duration must be a positive number, got ${String(targetDurationS)}`,
    );
  }
}

/** The scene count a target duration implies (~1 scene per 4.4 s at the 75 s reference). */
export function targetSceneCount(targetDurationS: number = SCENE_REFERENCE_DURATION_S): number {
  assertDuration(targetDurationS);
  const secondsPerScene = SCENE_REFERENCE_DURATION_S / SCENE_REFERENCE_COUNT;
  return Math.min(MAX_SCENES, Math.max(1, Math.round(targetDurationS / secondsPerScene)));
}

/** Em dash and en dash. Banned in generated scripts — see `buildScriptPrompt`. */
export const FORBIDDEN_DASH = /[\u2014\u2013]/;

/** The first script field carrying an em or en dash, or null when the script is clean. */
export function dashOffender(document: {
  readonly hook: string;
  readonly narration: string;
  readonly ending: string;
}): string | null {
  if (FORBIDDEN_DASH.test(document.hook)) return 'hook';
  if (FORBIDDEN_DASH.test(document.narration)) return 'narration';
  if (FORBIDDEN_DASH.test(document.ending)) return 'ending';
  return null;
}

/** Replace em/en dashes with the punctuation a reader would expect. */
export function stripForbiddenDashes(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,([.!?])/g, '$1');
}

/**
 * The acceptable count around the target: ±20 %, widened to ±1 when 20 % of a small
 * number rounds to nothing. A 10 s video therefore accepts 1–3 scenes (R-009-2's
 * own example) and the 75 s reference accepts 14–20 around 17.
 */
export function sceneCountBand(targetDurationS: number = SCENE_REFERENCE_DURATION_S): {
  readonly min: number;
  readonly max: number;
} {
  const target = targetSceneCount(targetDurationS);
  let min = Math.max(1, Math.round(target * 0.8));
  let max = Math.min(MAX_SCENES, Math.round(target * 1.2));
  if (max - min < 2) {
    min = Math.max(1, target - 1);
    max = Math.min(MAX_SCENES, target + 1);
  }
  return { min, max };
}

export interface SceneSplit {
  readonly scene_no: string;
  readonly position: number;
  readonly narration: string;
  readonly word_count: number;
  readonly start_word: number;
  /** Exclusive. */
  readonly end_word: number;
  readonly estimated_duration_s: number;
}

export function sceneNo(position: number): string {
  if (!Number.isInteger(position) || position < 0 || position >= MAX_SCENES) {
    throw new RangeError(
      `scene position must be an integer 0..${MAX_SCENES - 1}, got ${String(position)}`,
    );
  }
  return `S${String(position + 1).padStart(2, '0')}`;
}

export interface SplitNarrationOptions {
  readonly target_duration_s?: number;
  /** Overrides the target-derived count. */
  readonly scene_count?: number;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const WHITESPACE = /\s+/;

/**
 * Split spoken narration into ordered, non-empty scenes.
 *
 * Cuts are placed at roughly equal word counts, snapped to the nearest sentence
 * end when one is available — a scene should not start mid-sentence if the text
 * offers a boundary near the ideal position. Every word appears in exactly one
 * scene, in order, which is what makes the storyboard check below meaningful.
 */
export function splitNarration(
  narration: string,
  options: SplitNarrationOptions = {},
): SceneSplit[] {
  const words = narration.trim().length === 0 ? [] : narration.trim().split(WHITESPACE);
  if (words.length === 0) {
    throw new RangeError('narration is empty; there is nothing to split into scenes');
  }

  const targetDuration = options.target_duration_s ?? SCENE_REFERENCE_DURATION_S;
  assertDuration(targetDuration);
  const count = options.scene_count ?? targetSceneCount(targetDuration);
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`scene count must be a positive integer, got ${String(count)}`);
  }
  if (count > words.length) {
    throw new RangeError(`cannot split ${words.length} word(s) into ${count} non-empty scenes`);
  }
  if (count > MAX_SCENES) {
    throw new RangeError(`at most ${MAX_SCENES} scenes are addressable (S01…S99)`);
  }

  // Sentence ends expressed as exclusive cut positions.
  const sentenceEnds: number[] = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    if (SENTENCE_END.test(words[index] ?? '')) sentenceEnds.push(index + 1);
  }

  const cuts: number[] = [];
  let previous = 0;
  for (let k = 1; k < count; k += 1) {
    const remainingScenes = count - k;
    const lower = previous + 1;
    const upper = words.length - remainingScenes;
    const ideal = Math.min(upper, Math.max(lower, Math.round((k * words.length) / count)));

    let cut = ideal;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of sentenceEnds) {
      if (candidate < lower || candidate > upper) continue;
      const distance = Math.abs(candidate - ideal);
      if (distance < bestDistance || (distance === bestDistance && candidate < cut)) {
        bestDistance = distance;
        cut = candidate;
      }
    }

    cuts.push(cut);
    previous = cut;
  }

  const boundaries = [0, ...cuts, words.length];
  const scenes: SceneSplit[] = [];
  for (let position = 0; position < count; position += 1) {
    const start = boundaries[position] ?? 0;
    const end = boundaries[position + 1] ?? words.length;
    const sceneWords = words.slice(start, end);
    scenes.push({
      scene_no: sceneNo(position),
      position,
      narration: sceneWords.join(' '),
      word_count: sceneWords.length,
      start_word: start,
      end_word: end,
      estimated_duration_s: Number((sceneWords.length / NARRATION_WORDS_PER_SECOND).toFixed(3)),
    });
  }
  return scenes;
}

/** The spoken text of a script: hook + narration + ending, in that order. */
export function spokenNarration(script: {
  readonly hook: string;
  readonly narration: string;
  readonly ending: string;
}): string {
  return [script.hook, script.narration, script.ending]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Remove a hook the model restated at the top of the narration.
 *
 * The spoken text is hook + narration + ending, so a narration that opens by
 * repeating the hook says the opening line twice — heard as a stutter, and counted
 * twice against the word budget. Prompts have not prevented it, so the duplicate is
 * removed structurally: when the narration's first words match the hook's, those
 * words are dropped from the narration and it is re-capitalised.
 *
 * Deliberately conservative: only an exact word-for-word prefix counts (case and
 * punctuation ignored), the hook must be at least three words, and the narration
 * must still have at least eight words left — a trim that empties the body would
 * trade a repetition for a hole.
 */
export function dedupeHook<T extends { readonly hook: string; readonly narration: string }>(
  script: T,
): T {
  const hookWords = wordsOf(script.hook);
  if (hookWords.length < 3) return script;
  const narrationWords = wordsOf(script.narration);
  if (narrationWords.length <= hookWords.length + 8) return script;
  const prefixMatches = hookWords.every((word, index) => narrationWords[index] === word);
  if (!prefixMatches) return script;

  const rest = cutWords(script.narration, hookWords.length)
    .replace(/^[\s,;:.!?\u2014\u2013-]+/u, '')
    .trim();
  if (rest === '') return script;
  return { ...script, narration: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/** Lower-cased, punctuation-free words — the form two texts are compared in. */
function wordsOf(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/[\p{L}\p{N}']+/gu), (match) =>
    match[0].replace(/'/g, ''),
  );
}

/** Everything after the first `count` words of `text`, punctuation intact. */
function cutWords(text: string, count: number): string {
  const pattern = /[\p{L}\p{N}']+/gu;
  let seen = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    seen += 1;
    if (seen === count) return text.slice(match.index + match[0].length);
    match = pattern.exec(text);
  }
  return '';
}

export interface StoryboardSceneInput {
  readonly scene_no: string;
  readonly narration: string;
  readonly image_prompt: string;
  readonly camera_move: CameraMove;
  readonly caption_emphasis?: string | null;
  readonly fallback_text?: string | null;
}

export interface StoryboardPlanScene extends SceneSplit {
  readonly image_prompt: string;
  readonly camera_move: CameraMove;
  readonly caption_emphasis: string | null;
  readonly fallback_text: string | null;
}

export interface StoryboardPlanInput {
  readonly approved_narration: string;
  readonly document: { readonly scenes: readonly StoryboardSceneInput[] };
  readonly target_duration_s?: number;
}

export interface StoryboardPlan {
  readonly scene_count: number;
  readonly target_scene_count: number;
  readonly band: { readonly min: number; readonly max: number };
  readonly narration_word_count: number;
  readonly scenes: readonly StoryboardPlanScene[];
}

export type StoryboardMismatchCode =
  'empty_storyboard' | 'scene_id_sequence' | 'scene_count_out_of_band' | 'narration_mismatch';

export class StoryboardMismatchError extends Error {
  constructor(
    readonly code: StoryboardMismatchCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'StoryboardMismatchError';
  }
}

function assertSceneIds(scenes: readonly StoryboardSceneInput[]): void {
  const seen = new Set<string>();
  scenes.forEach((scene, position) => {
    if (seen.has(scene.scene_no)) {
      throw new StoryboardMismatchError(
        'scene_id_sequence',
        `duplicate scene_no ${scene.scene_no} at position ${position} (R-007-2: ids are stable and unique)`,
      );
    }
    seen.add(scene.scene_no);
    const expected = sceneNo(position);
    if (scene.scene_no !== expected) {
      throw new StoryboardMismatchError(
        'scene_id_sequence',
        `scene_no ${scene.scene_no} at position ${position} should be ${expected} (R-007-2)`,
      );
    }
  });
}

function assertNarrationCoverage(
  approvedNarration: string,
  scenes: readonly StoryboardSceneInput[],
): readonly string[] {
  const approved = normaliseWords(approvedNarration);
  const assembled = normaliseWords(scenes.map((scene) => scene.narration).join(' '));

  if (approved.length !== assembled.length) {
    throw new StoryboardMismatchError(
      'narration_mismatch',
      `scene narration reconstructs ${assembled.length} word(s) but the approved narration has ${approved.length}`,
    );
  }
  for (let index = 0; index < approved.length; index += 1) {
    if (approved[index] !== assembled[index]) {
      throw new StoryboardMismatchError(
        'narration_mismatch',
        `scene narration differs from the approved narration at word ${index + 1}: ` +
          `"${String(assembled[index])}" vs "${String(approved[index])}"`,
      );
    }
  }
  return approved;
}

/**
 * Turn a validated storyboard document into the scene plan the image stage needs,
 * after proving it is a split of the approved narration rather than a rewrite.
 */
export function planStoryboard(input: StoryboardPlanInput): StoryboardPlan {
  const scenes = input.document.scenes;
  if (scenes.length === 0) {
    throw new StoryboardMismatchError('empty_storyboard', 'a storyboard needs at least one scene');
  }

  assertSceneIds(scenes);

  const targetDuration = input.target_duration_s ?? SCENE_REFERENCE_DURATION_S;
  assertDuration(targetDuration);
  const target = targetSceneCount(targetDuration);
  const band = sceneCountBand(targetDuration);
  if (scenes.length < band.min || scenes.length > band.max) {
    throw new StoryboardMismatchError(
      'scene_count_out_of_band',
      `scene count ${scenes.length} is outside ${band.min}–${band.max} for a ${targetDuration} s target (R-009-2: ~${target} scenes)`,
    );
  }

  const narrationWords = assertNarrationCoverage(input.approved_narration, scenes);

  let cursor = 0;
  const planned: StoryboardPlanScene[] = scenes.map((scene, position) => {
    const wordCount = countWords(scene.narration);
    const start = cursor;
    cursor += wordCount;
    return {
      scene_no: scene.scene_no,
      position,
      narration: scene.narration.trim(),
      word_count: wordCount,
      start_word: start,
      end_word: cursor,
      estimated_duration_s: Number((wordCount / NARRATION_WORDS_PER_SECOND).toFixed(3)),
      image_prompt: scene.image_prompt,
      camera_move: scene.camera_move,
      caption_emphasis: scene.caption_emphasis ?? null,
      fallback_text: scene.fallback_text ?? null,
    };
  });

  return {
    scene_count: planned.length,
    target_scene_count: target,
    band,
    narration_word_count: narrationWords.length,
    scenes: planned,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The script draft pipeline — US-017, R-004-2
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalBlockerCode = 'eight_gram' | 'unresolved_claims';

export interface ApprovalBlocker {
  readonly code: ApprovalBlockerCode;
  readonly detail: string;
}

export interface ScriptDraftDeps {
  /** One SC generation call; production passes B-04's adapter, tests a fake. */
  generate(attemptNo: number): Promise<unknown>;
  onInvalid?(failure: ValidationFailure): void | Promise<void>;
}

export interface ScriptDraftInput extends ScriptPromptInput {
  readonly claims?: readonly ClaimInput[];
  readonly sources?: readonly SourceInput[];
}

export interface ScriptDraft {
  readonly content: ScriptDocument;
  readonly schema_version: string;
  readonly attempts: number;
  readonly failures: readonly ValidationFailure[];
  readonly prompt: ScriptPrompt;
  readonly word_budget: WordBudgetCheck;
  readonly eight_gram: EightGramScanResult;
  readonly claims: ClaimMapping;
  /** Non-blocking observations for S-10 (out-of-band word count). */
  readonly warnings: readonly string[];
  /** R-005-2 preconditions that must clear before the script can be approved. */
  readonly approval_blockers: readonly ApprovalBlocker[];
}

export type ScriptDraftResult =
  | { readonly ok: true; readonly draft: ScriptDraft }
  | {
      readonly ok: false;
      readonly failure: ValidationFailure;
      readonly failures: readonly ValidationFailure[];
    };

/**
 * Draft, validate, scan and map. The reference check runs before the first
 * generation call, so an invalid series profile costs nothing; a malformed model
 * document runs out the R-004-2 ceiling and returns the failure instead of a
 * draft.
 */
export async function draftScript(
  input: ScriptDraftInput,
  deps: ScriptDraftDeps,
): Promise<ScriptDraftResult> {
  assertReferenceSet(input.references);
  const prompt = buildScriptPrompt(input);

  const outcome = await validateWithRetry({
    schema: TEXT_SCHEMAS.script,
    generate: deps.generate,
    onInvalid: deps.onInvalid,
  });
  if (!outcome.ok) {
    return { ok: false, failure: outcome.failure, failures: outcome.failures };
  }

  const content = outcome.document;
  const targetDuration = input.target_duration_s ?? DEFAULT_TARGET_DURATION_S;
  const wordBudgetCheck = checkWordBudget(spokenNarration(content), targetDuration);
  const eightGram = scanScript(content, input.references);
  const claims = mapClaimsToSources(input.claims ?? [], input.sources ?? [], {
    mode: input.series.mode,
  });

  const warnings: string[] = [];
  if (!wordBudgetCheck.within_band) {
    warnings.push(
      `narration is ${wordBudgetCheck.word_count} words; the ${targetDuration} s band is ` +
        `${wordBudgetCheck.budget.min_words}–${wordBudgetCheck.budget.max_words} words (R-009-2)`,
    );
  }

  const approvalBlockers: ApprovalBlocker[] = [];
  if (!eightGram.pass) {
    approvalBlockers.push({
      code: 'eight_gram',
      detail: eightGram.violation_strings.join(' | '),
    });
  }
  if (!claims.all_resolved) {
    approvalBlockers.push({
      code: 'unresolved_claims',
      detail: `${claims.unresolved.length} factual claim(s) have no accepted source`,
    });
  }

  return {
    ok: true,
    draft: {
      content,
      schema_version: outcome.schema_version,
      attempts: outcome.attempts,
      failures: outcome.failures,
      prompt,
      word_budget: wordBudgetCheck,
      eight_gram: eightGram,
      claims,
      warnings,
      approval_blockers: approvalBlockers,
    },
  };
}
