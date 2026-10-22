import { describe, expect, it } from 'vitest';

import { ScriptContentSchema as ContractScriptContentSchema } from '../../contract/api.js';
import { QUIET_MACHINES_FIXTURES } from './text-fixtures.js';
import {
  jsonSchemaFor,
  SCENE_NO_PATTERN,
  schemaHashOf,
  TEXT_SCHEMAS,
  TopicDocumentSchema,
  SCRIPT_DOCUMENT_VERSION,
  STORYBOARD_DOCUMENT_VERSION,
  TOPIC_DOCUMENT_VERSION,
} from './text-schemas.js';

/** Count spoken words the way the narration budget is measured (QUALIFICATION §2). */
function spokenWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * B-04 Signal, part 1: the text-stage fixtures are schema-conformant.
 * R-004-1 / R-008-3: topic, script and storyboard each validate against a
 * versioned schema, and the script document agrees with the frozen API contract.
 */
describe('text document schemas (R-004-1, R-008-3)', () => {
  it('pins a version per stage so a silent shape change cannot pass as the same schema', () => {
    expect(TEXT_SCHEMAS.topic.version).toBe(TOPIC_DOCUMENT_VERSION);
    expect(TEXT_SCHEMAS.script.version).toBe(SCRIPT_DOCUMENT_VERSION);
    expect(TEXT_SCHEMAS.storyboard.version).toBe(STORYBOARD_DOCUMENT_VERSION);
    expect(TEXT_SCHEMAS.topic.stage).toBe('T');
    expect(TEXT_SCHEMAS.script.stage).toBe('SC');
    expect(TEXT_SCHEMAS.storyboard.stage).toBe('SB');
    expect(TOPIC_DOCUMENT_VERSION).toBe('topic.v1');
    expect(SCRIPT_DOCUMENT_VERSION).toBe('script.v2');
    expect(STORYBOARD_DOCUMENT_VERSION).toBe('storyboard.v1');
  });

  it('accepts the shipped topic fixture', () => {
    expect(() => TopicDocumentSchema.parse(QUIET_MACHINES_FIXTURES.topic)).not.toThrow();
  });

  it('accepts the shipped script fixture and agrees with the frozen API contract', () => {
    expect(() => TEXT_SCHEMAS.script.schema.parse(QUIET_MACHINES_FIXTURES.script)).not.toThrow();
    // The worker and the UI must not disagree about script content (LEAD_PLAN §6).
    const contractView = ContractScriptContentSchema.safeParse(QUIET_MACHINES_FIXTURES.script);
    expect(contractView.success).toBe(true);
  });

  it('accepts the shipped storyboard fixture with stable S01…S17 scene ids', () => {
    const parsed = TEXT_SCHEMAS.storyboard.schema.parse(QUIET_MACHINES_FIXTURES.storyboard);
    expect(parsed.scenes).toHaveLength(17);
    expect(parsed.scenes.map((scene) => scene.scene_no)).toEqual(
      Array.from({ length: 17 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
    );
    expect(new Set(parsed.scenes.map((scene) => scene.scene_no)).size).toBe(17);
  });

  it('keeps the script inside the measured 75 s word band (216–239, R-009-2/3)', () => {
    const spoken = QUIET_MACHINES_FIXTURES.script.script;
    const words = spokenWords(spoken);
    expect(words).toBeGreaterThanOrEqual(216);
    expect(words).toBeLessThanOrEqual(239);
  });

  it('rejects a document that is not conformant, naming the field', () => {
    const broken = { ...QUIET_MACHINES_FIXTURES.script, script: undefined };
    const result = TEXT_SCHEMAS.script.schema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('script');
    }
  });

  it('rejects an unknown camera move and a malformed scene id', () => {
    const scenes = [...QUIET_MACHINES_FIXTURES.storyboard.scenes];
    scenes[0] = { ...scenes[0]!, camera_move: 'dolly_zoom' as never };
    expect(TEXT_SCHEMAS.storyboard.schema.safeParse({ scenes }).success).toBe(false);

    const badId = [...QUIET_MACHINES_FIXTURES.storyboard.scenes];
    badId[1] = { ...badId[1]!, scene_no: 'scene-2' };
    expect(TEXT_SCHEMAS.storyboard.schema.safeParse({ scenes: badId }).success).toBe(false);
  });

  it('bounds scene ids to the two-digit S01…S99 space', () => {
    expect(SCENE_NO_PATTERN.test('S01')).toBe(true);
    expect(SCENE_NO_PATTERN.test('S17')).toBe(true);
    expect(SCENE_NO_PATTERN.test('S99')).toBe(true);
    expect(SCENE_NO_PATTERN.test('S00')).toBe(false);
    expect(SCENE_NO_PATTERN.test('S100')).toBe(false);
  });

  it('derives a provider JSON schema and a stable schema hash for provenance', () => {
    const json = jsonSchemaFor(TEXT_SCHEMAS.script);
    expect(json).toMatchObject({ type: 'object' });
    expect(json.required).toEqual(
      expect.arrayContaining(['script', 'title', 'description', 'hashtags']),
    );

    const first = schemaHashOf(TEXT_SCHEMAS.script);
    const second = schemaHashOf(TEXT_SCHEMAS.script);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(schemaHashOf(TEXT_SCHEMAS.topic)).not.toBe(first);
  });
});
