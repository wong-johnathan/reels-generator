/**
 * Versioned schemas for the three text stages — R-004-1, R-008-3.
 *
 * One authority per stage, used for three things at once:
 * 1. the `response_format` the adapter declares (DeepSeek honours
 *    `json_object`; the schema itself is enforced locally, never trusted to
 *    the provider),
 * 2. the parse that rejects a malformed model document before any billable
 *    downstream stage (R-004-1),
 * 3. the qualification check `qualify()` runs per schema (R-008-3).
 *
 * Versioning: the version string is stored on `generation_run.schema_version`
 * and `script_revision.schema_version`; a document produced under a different
 * shape must not be validated against this one. Treat a change to any schema
 * below as a **new version string**, not an edit in place.
 *
 * `script.v1` deliberately matches `contract/api.ts::ScriptContentSchema`
 * (asserted by `text-schemas.test.ts`), so the worker and the UI cannot drift
 * (LEAD_PLAN §6). Topic and storyboard mirror the TECH_DESIGN §3.2 columns.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { CAMERA_MOVES } from '../shared/states.js';

/** The text stages: topic (T), script (SC), storyboard (SB). */
export const TEXT_STAGE_CODES = ['T', 'SC', 'SB'] as const;
export type TextStageCode = (typeof TEXT_STAGE_CODES)[number];

export type TextSchemaName = 'topic' | 'script' | 'storyboard';

export const TOPIC_DOCUMENT_VERSION = 'topic.v1';
export const SCRIPT_DOCUMENT_VERSION = 'script.v1';
export const STORYBOARD_DOCUMENT_VERSION = 'storyboard.v1';

/** `S01`…`S99` — the stable scene id (R-007-2, TECH_DESIGN §3.2). */
export const SCENE_NO_PATTERN = /^S(0[1-9]|[1-9][0-9])$/;

/** A JSON Schema document, as the adapter reports it to a provider. */
export type JsonSchema = Record<string, unknown> & {
  readonly type?: string;
  readonly required?: readonly string[];
};

export const TopicDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  /** Why this topic fits the series; null when the model offers none. */
  rationale: z.string().min(1).max(2000).nullable(),
});

export const ScriptDocumentSchema = z.object({
  hook: z
    .string()
    .min(1)
    .describe(
      'The first line spoken, one sentence, the line that stops the scroll. It is spoken once, at the very start.',
    ),
  narration: z
    .string()
    .min(1)
    .describe(
      'The body of the video, spoken immediately after the hook. Continue from the hook: never repeat it, and never restate it in different words.',
    ),
  ending: z
    .string()
    .min(1)
    .describe('The closing line, spoken last. It must not repeat the hook either.'),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  hashtags: z
    .array(z.string().regex(/^#[A-Za-z0-9_]+$/))
    .min(1)
    .max(30),
});

export const StoryboardDocumentSchema = z.object({
  scenes: z
    .array(
      z.object({
        scene_no: z.string().regex(SCENE_NO_PATTERN),
        narration: z.string().min(1),
        /** No captions/lettering instructions in an image prompt (US-019). */
        image_prompt: z.string().min(1),
        camera_move: z.enum(CAMERA_MOVES),
        caption_emphasis: z.string().min(1).nullable(),
        fallback_text: z.string().min(1).nullable(),
      }),
    )
    .min(1)
    // Ids are two digits, so 99 is the ceiling of the format itself.
    .max(99),
});

/** Stable key order, so a schema hash is reproducible across runs. */
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

/**
 * One text-stage schema: its versioned identity, the zod validator the adapter
 * enforces, and the JSON Schema it reports for provenance/qualification.
 */
export interface TextSchema<Out = unknown> {
  readonly name: TextSchemaName;
  readonly version: string;
  readonly stage: TextStageCode;
  readonly schema: z.ZodType<Out>;
  readonly jsonSchema: JsonSchema;
  /** sha256 of the canonical JSON Schema — recorded on qualification rows. */
  readonly hash: string;
  parse(value: unknown): Out;
}

/** What every stage exposes about its own version (structural, variance-free). */
export interface TextSchemaIdentity {
  readonly jsonSchema: JsonSchema;
  readonly hash: string;
}

function defineTextSchema<Out>(definition: {
  readonly name: TextSchemaName;
  readonly version: string;
  readonly stage: TextStageCode;
  readonly schema: z.ZodType<Out>;
}): TextSchema<Out> {
  const jsonSchema = z.toJSONSchema(definition.schema) as unknown as JsonSchema;
  return {
    name: definition.name,
    version: definition.version,
    stage: definition.stage,
    schema: definition.schema,
    jsonSchema,
    hash: createHash('sha256').update(canonicalJson(jsonSchema)).digest('hex'),
    parse: (value: unknown) => definition.schema.parse(value),
  };
}

export const TEXT_SCHEMAS = {
  topic: defineTextSchema({
    name: 'topic',
    version: TOPIC_DOCUMENT_VERSION,
    stage: 'T',
    schema: TopicDocumentSchema,
  }),
  script: defineTextSchema({
    name: 'script',
    version: SCRIPT_DOCUMENT_VERSION,
    stage: 'SC',
    schema: ScriptDocumentSchema,
  }),
  storyboard: defineTextSchema({
    name: 'storyboard',
    version: STORYBOARD_DOCUMENT_VERSION,
    stage: 'SB',
    schema: StoryboardDocumentSchema,
  }),
} as const;

/** The provider-facing JSON Schema for a stage (provenance, qualification details). */
export function jsonSchemaFor(schema: TextSchemaIdentity): JsonSchema {
  return schema.jsonSchema;
}

/** sha256 of a stage's canonical JSON Schema — the version's fingerprint. */
export function schemaHashOf(schema: TextSchemaIdentity): string {
  return schema.hash;
}
