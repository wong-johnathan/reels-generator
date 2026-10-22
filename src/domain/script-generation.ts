/**
 * Two-phase script generation primitives (US-017, R-009-1).
 *
 * The persisted/API contract stays the single `script` field (script.v2). These
 * primitives build that field deterministically from a frozen frame (hook +
 * ending) and a word-budgeted middle narration, so the 217-239 word band is met
 * by arithmetic rather than by asking the model to count its own output.
 *
 * Everything here is pure: no provider, no database. The internal frame and
 * narration schemas are NOT persisted and NOT qualified - they exist only to
 * validate provider responses inside the SC stage.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { JsonSchema } from '../adapters/text-schemas.js';
import { countWords, stripForbiddenDashes, type ScriptDocument } from './authoring.js';
import { wordBudget } from '../shared/calibration.js';

export const SCRIPT_FRAME_SCHEMA_VERSION = 'script-frame.v1';
export const SCRIPT_NARRATION_SCHEMA_VERSION = 'script-narration.v1';

/** Explicit output ceilings so a JSON body is never truncated mid-count. */
export const SC_FRAME_MAX_TOKENS = 1024;
export const SC_NARRATION_MAX_TOKENS = 1536;
export const SC_REPAIR_MAX_TOKENS = 1536;

/** Internal: the frame call returns the opening, landing and metadata. */
export const scriptFrameSchema = z.object({
  hook: z.string().min(1),
  ending: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  hashtags: z
    .array(z.string().regex(/^#[A-Za-z0-9_]+$/))
    .min(1)
    .max(30),
});
export type ScriptFrame = z.infer<typeof scriptFrameSchema>;

/** Internal: the narration call returns only the middle. */
export const scriptNarrationSchema = z.object({
  narration: z.string().min(1),
});
export type ScriptNarration = z.infer<typeof scriptNarrationSchema>;

/**
 * The minimal schema surface the text adapter and system prompt consume. It is
 * structurally a `TextSchema` (cast at the call site) but is NOT registered in
 * `TEXT_SCHEMAS`, so qualification and script.v2 are untouched.
 */
export interface ScriptPartSchema<Out> {
  readonly name: string;
  readonly version: string;
  readonly stage: 'SC';
  readonly schema: z.ZodType<Out>;
  readonly jsonSchema: JsonSchema;
  readonly hash: string;
  parse(value: unknown): Out;
}

/** Stable key order, so a schema hash is reproducible across runs (as in text-schemas.ts). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function defineScriptPart<Out>(
  name: string,
  version: string,
  schema: z.ZodType<Out>,
): ScriptPartSchema<Out> {
  const jsonSchema = z.toJSONSchema(schema) as unknown as JsonSchema;
  return {
    name,
    version,
    stage: 'SC',
    schema,
    jsonSchema,
    hash: createHash('sha256').update(canonicalJson(jsonSchema)).digest('hex'),
    parse: (value: unknown) => schema.parse(value),
  };
}

export const SCRIPT_FRAME_PART: ScriptPartSchema<ScriptFrame> = defineScriptPart(
  'script-frame',
  SCRIPT_FRAME_SCHEMA_VERSION,
  scriptFrameSchema,
);
export const SCRIPT_NARRATION_PART: ScriptPartSchema<ScriptNarration> = defineScriptPart(
  'script-narration',
  SCRIPT_NARRATION_SCHEMA_VERSION,
  scriptNarrationSchema,
);

/** A frame whose hook and ending have been validated and dash-stripped (frozen). */
export interface FrozenFrame {
  readonly hook: string;
  readonly ending: string;
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
}

/** Validate and clean a frame; throws on an empty hook/ending after cleaning. */
export function freezeFrame(frame: ScriptFrame): FrozenFrame {
  const hook = stripForbiddenDashes(frame.hook).trim();
  const ending = stripForbiddenDashes(frame.ending).trim();
  if (hook === '') throw new Error('frame hook is empty after cleaning');
  if (ending === '') throw new Error('frame ending is empty after cleaning');
  return Object.freeze({
    hook,
    ending,
    title: frame.title.trim(),
    description: frame.description.trim(),
    hashtags: Object.freeze([...frame.hashtags]),
  });
}

/** Words already committed to the frozen frame (hook + ending). */
export function frameWordCount(frame: FrozenFrame): number {
  return countWords(frame.hook) + countWords(frame.ending);
}

/**
 * The narration target a frozen frame implies: the exact word target minus the
 * words the frame already spends. Never below one word.
 */
export function narrationWordTarget(frame: FrozenFrame, targetDurationS: number): number {
  return Math.max(1, wordBudget(targetDurationS).target_words - frameWordCount(frame));
}

/** Assemble the persisted script.v2 document: hook + narration + ending. */
export function assembleScript(frame: FrozenFrame, narration: string): ScriptDocument {
  const parts = [frame.hook, narration.trim(), frame.ending].filter((part) => part.trim() !== '');
  return {
    script: parts.join(' '),
    title: frame.title,
    description: frame.description,
    hashtags: [...frame.hashtags],
  };
}

/**
 * Signed word delta to apply to the middle narration: positive = expand,
 * negative = cut. Equals the narration delta because hook/ending are frozen.
 */
export function narrationRepairDelta(assembledWordCount: number, targetDurationS: number): number {
  return wordBudget(targetDurationS).target_words - assembledWordCount;
}

/** True when the narration opens by restating the frozen hook verbatim. */
export function narrationRestatesHook(hook: string, narration: string): boolean {
  const trimmedHook = hook.trim();
  const trimmedNarration = narration.trim();
  return trimmedHook.length > 0 && trimmedNarration.startsWith(trimmedHook);
}
