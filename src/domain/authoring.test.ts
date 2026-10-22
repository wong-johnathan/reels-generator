/**
 * US-017 (script draft + reference handling) and US-018 (storyboard split) —
 * R-003-1…4, R-004-1, R-009-2, R-027.
 *
 * The pipeline is exercised with an injected generator: no adapter, no socket,
 * no paid provider. The generator is the seam where B-04's text adapter goes in
 * production, and each call is one committed `generation_run` attempt (B-08).
 */
import { describe, expect, it, vi } from 'vitest';

import { QUIET_MACHINES_FIXTURES } from '../adapters/text-fixtures.js';
import { SCRIPT_DOCUMENT_VERSION, TEXT_SCHEMAS } from '../adapters/text-schemas.js';
import {
  MAX_REFERENCES,
  ReferenceSetError,
  StoryboardMismatchError,
  assertReferenceSet,
  buildScriptPrompt,
  checkWordBudget,
  dashOffender,
  draftScript,
  mapClaimsToSources,
  planStoryboard,
  stripForbiddenDashes,
  sceneCountBand,
  spokenNarration,
  splitNarration,
  targetSceneCount,
  type ClaimInput,
  type SeriesReference,
  type SourceInput,
  type StoryboardSceneInput,
} from './authoring.js';

const REFERENCE_TEXT =
  'The quiet machine hums in the corner of the studio while the operator waits for the render to finish.';

const reference: SeriesReference = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Machine notes',
  source_text: REFERENCE_TEXT,
  extracted_style_summary: 'Calm, second person, short declaratives, one concrete object per beat.',
  rights_note: 'Operator-written notes, 2026, all rights retained.',
};

const series = { mode: 'creative' as const, niche: 'psychology for solo builders' };

function promptText(prompt: ReturnType<typeof buildScriptPrompt>): string {
  return prompt.messages.map((message) => message.content).join('\n');
}

function sceneInputs(count: number): StoryboardSceneInput[] {
  return splitNarration(spokenNarration(QUIET_MACHINES_FIXTURES.script), {
    target_duration_s: 75,
    scene_count: count,
  }).map((scene) => ({
    scene_no: scene.scene_no,
    narration: scene.narration,
    image_prompt: `Inked comic panel for ${scene.scene_no}, no text or lettering`,
    camera_move: 'static' as const,
    caption_emphasis: null,
    fallback_text: null,
  }));
}

describe('US-017 R-003-1 / R-003-4 — the stored reference set', () => {
  it('accepts one to five references that carry a summary, rights note and source text', () => {
    expect(() => assertReferenceSet([reference])).not.toThrow();
    expect(() =>
      assertReferenceSet(
        Array.from({ length: MAX_REFERENCES }, (_, index) => ({
          ...reference,
          id: `${index + 1}1111111-1111-4111-8111-111111111111`,
        })),
      ),
    ).not.toThrow();
  });

  it('rejects an empty set and more than five references', () => {
    expect(() => assertReferenceSet([])).toThrow(ReferenceSetError);
    expect(() => assertReferenceSet([])).toThrow(/at least 1/);
    expect(() =>
      assertReferenceSet(
        Array.from({ length: MAX_REFERENCES + 1 }, (_, index) => ({
          ...reference,
          id: `${index + 1}1111111-1111-4111-8111-111111111111`,
        })),
      ),
    ).toThrow(/at most 5/);
  });

  it('rejects a reference without a rights note, a style summary or stored source text', () => {
    expect(() => assertReferenceSet([{ ...reference, rights_note: '  ' }])).toThrow(/rights note/i);
    expect(() => assertReferenceSet([{ ...reference, extracted_style_summary: '' }])).toThrow(
      /style summary/i,
    );
    expect(() => assertReferenceSet([{ ...reference, source_text: ' ' }])).toThrow(/source text/i);
  });
});

describe('US-017 R-003-3 — the provider request carries only the style summary', () => {
  const prompt = buildScriptPrompt({
    series,
    topic: {
      title: 'Some decisions deserve the slow lane',
      description: 'Why reversible choices are the cheap ones.',
      rationale: 'Fits the series premise.',
    },
    references: [reference],
    target_duration_s: 75,
  });

  it('includes every extracted style summary', () => {
    expect(promptText(prompt)).toContain(reference.extracted_style_summary);
  });

  it('never includes reference source text', () => {
    expect(promptText(prompt)).not.toContain(REFERENCE_TEXT);
    // Even an eight-word fragment of the stored text must be absent.
    expect(promptText(prompt)).not.toContain(REFERENCE_TEXT.split(' ').slice(0, 8).join(' '));
  });

  it('declares the versioned script schema, the stage and the pinned word budget', () => {
    expect(prompt.stage).toBe('SC');
    expect(prompt.schema_version).toBe(SCRIPT_DOCUMENT_VERSION);
    expect(prompt.schema_version).toBe(TEXT_SCHEMAS.script.version);
    expect(prompt.word_budget.target_words).toBe(228);
    expect(prompt.word_budget.max_words).toBe(239);
    // A countable instruction, not just a number: 'target 228 words' alone was
    // ignored and produced 136.
    const userMessage = prompt.messages.map((m) => m.content).join('\n');
    expect(userMessage).toContain('COUNT the words before you answer');
    expect(userMessage).toContain('about 17 scenes');
    expect(userMessage).toContain('217–239');
    expect(promptText(prompt)).toContain('script.v2');
    expect(promptText(prompt)).toContain('228');
  });

  it('includes the topic and, in factual mode, the claim list', () => {
    const factual = buildScriptPrompt({
      series: { mode: 'factual', niche: 'psychology' },
      topic: { title: 'A factual topic', description: 'A factual description.' },
      references: [reference],
      claims: [{ text: 'Most founders quit in month nine.', is_factual: true }],
    });

    expect(promptText(factual)).toContain('A factual topic');
    expect(promptText(factual)).toContain('Most founders quit in month nine.');
    expect(factual.series_mode).toBe('factual');
  });
});

describe('US-017 word budget — R-009-2/3', () => {
  it('reports the canonical fixture inside the 75 s band', () => {
    const check = checkWordBudget(spokenNarration(QUIET_MACHINES_FIXTURES.script));

    expect(check.budget.target_words).toBe(228);
    expect(check.budget.max_words).toBe(239);
    expect(check.word_count).toBeGreaterThanOrEqual(check.budget.min_words);
    expect(check.word_count).toBeLessThanOrEqual(check.budget.max_words);
    expect(check.within_band).toBe(true);
    expect(check.estimated_runtime_s).toBeCloseTo(check.word_count / 3.035, 3);
  });

  it('flags a narration outside the band', () => {
    const short = checkWordBudget(
      Array.from({ length: 80 }, (_, index) => `word${index}`).join(' '),
    );
    expect(short.within_band).toBe(false);
    expect(short.word_count).toBe(80);
  });
});

describe('US-017 claim→source mapping — R-014-1 / R-027', () => {
  const sources: SourceInput[] = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      url: 'https://example.org/founders',
      title: 'Founder attrition',
      retrieved_at: '2026-10-20T09:00:00.000Z',
      rerank_score: 2.31,
      status: 'accepted',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      url: 'https://example.org/thin',
      title: 'Thin result',
      retrieved_at: '2026-10-20T09:00:00.000Z',
      rerank_score: 1.4,
      status: 'accepted',
    },
  ];

  const sourced: ClaimInput = {
    text: 'Most founders quit in month nine.',
    is_factual: true,
    source_id: sources[0]!.id,
  };

  it('maps a factual claim to its accepted source and builds the manifest row', () => {
    const mapping = mapClaimsToSources([sourced], sources, { mode: 'factual' });

    expect(mapping.all_resolved).toBe(true);
    expect(mapping.unresolved).toEqual([]);
    const row = mapping.rows[0]!;
    expect(row.status).toBe('sourced');
    expect(row.url).toBe('https://example.org/founders');
    expect(row.retrieved_at).toBe('2026-10-20T09:00:00.000Z');
    expect(mapping.manifest_rows).toEqual([
      {
        claim_text: sourced.text,
        url: 'https://example.org/founders',
        retrieved_at: '2026-10-20T09:00:00.000Z',
        status: 'sourced',
      },
    ]);
  });

  it('refuses a source below the 1.5 rerank threshold and leaves the claim unresolved', () => {
    const mapping = mapClaimsToSources([{ ...sourced, source_id: sources[1]!.id }], sources, {
      mode: 'factual',
    });

    expect(mapping.all_resolved).toBe(false);
    expect(mapping.rows[0]!.status).toBe('url_unreachable');
    expect(mapping.unresolved).toHaveLength(1);
    expect(mapping.manifest_rows).toEqual([]);
  });

  it('leaves an unlinked factual claim unsourced', () => {
    const mapping = mapClaimsToSources(
      [{ text: 'An unsupported assertion.', is_factual: true }],
      sources,
      { mode: 'factual' },
    );

    expect(mapping.rows[0]!.status).toBe('unsourced');
    expect(mapping.all_resolved).toBe(false);
  });

  it('marks a source id that resolves to nothing as url_unreachable', () => {
    const mapping = mapClaimsToSources(
      [{ ...sourced, source_id: '44444444-4444-4444-8444-444444444444' }],
      sources,
      { mode: 'factual' },
    );

    expect(mapping.rows[0]!.status).toBe('url_unreachable');
    expect(mapping.rows[0]!.url).toBeNull();
  });

  it('excludes non-factual claims from the mapping and the manifest', () => {
    const mapping = mapClaimsToSources(
      [sourced, { text: 'A reworded aside.', is_factual: false }],
      sources,
      { mode: 'factual' },
    );

    expect(mapping.rows.map((row) => row.status)).toEqual(['sourced', 'non_factual']);
    expect(mapping.manifest_rows).toHaveLength(1);
    expect(mapping.all_resolved).toBe(true);
  });

  it('applies no citation rows in creative mode', () => {
    const mapping = mapClaimsToSources([sourced], sources, { mode: 'creative' });

    expect(mapping.mode).toBe('creative');
    expect(mapping.rows).toEqual([]);
    expect(mapping.manifest_rows).toEqual([]);
    expect(mapping.all_resolved).toBe(true);
  });
});

describe('US-018 R-009-2 — scene count adapts to the target', () => {
  it('uses ~17 scenes for the 75 s reference and 1–3 for a 10 s video', () => {
    expect(targetSceneCount(75)).toBe(17);
    expect(sceneCountBand(75)).toEqual({ min: 14, max: 20 });
    const short = sceneCountBand(10);
    expect(short.min).toBeGreaterThanOrEqual(1);
    expect(short.max).toBeLessThanOrEqual(3);
  });

  it('splits the approved narration into sequential, non-empty scenes that reconstruct it', () => {
    const narration = spokenNarration(QUIET_MACHINES_FIXTURES.script);
    const scenes = splitNarration(narration, { target_duration_s: 75 });

    expect(scenes).toHaveLength(17);
    expect(scenes.map((scene) => scene.scene_no)).toEqual(
      Array.from({ length: 17 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
    );
    expect(scenes.map((scene) => scene.position)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    for (const scene of scenes) {
      expect(scene.word_count).toBeGreaterThan(0);
      expect(scene.narration.trim().length).toBeGreaterThan(0);
    }
    expect(
      scenes
        .map((scene) => scene.narration)
        .join(' ')
        .replace(/\s+/g, ' '),
    ).toBe(narration.replace(/\s+/g, ' '));
    const totalSeconds = scenes.reduce((sum, scene) => sum + scene.estimated_duration_s, 0);
    expect(totalSeconds).toBeGreaterThan(71);
    expect(totalSeconds).toBeLessThan(79);
  });

  it('adapts to a shorter target (1–3 scenes)', () => {
    const scenes = splitNarration(spokenNarration(QUIET_MACHINES_FIXTURES.script), {
      target_duration_s: 10,
    });
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    expect(scenes.length).toBeLessThanOrEqual(3);
    expect(scenes[0]!.scene_no).toBe('S01');
  });
});

describe('US-018 storyboard plan', () => {
  const narration = spokenNarration(QUIET_MACHINES_FIXTURES.script);

  it('accepts a storyboard whose scene narration reconstructs the approved script', () => {
    const plan = planStoryboard({
      approved_narration: narration,
      target_duration_s: 75,
      document: { scenes: sceneInputs(17) },
    });

    expect(plan.scene_count).toBe(17);
    expect(plan.target_scene_count).toBe(17);
    expect(plan.band).toEqual({ min: 14, max: 20 });
    expect(plan.scenes.map((scene) => scene.scene_no)).toEqual(
      Array.from({ length: 17 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
    );
    for (const scene of plan.scenes) {
      expect(scene.image_prompt.length).toBeGreaterThan(0);
      expect(scene.narration.length).toBeGreaterThan(0);
    }
  });

  it('rejects a storyboard that drops or alters narration words', () => {
    const scenes = sceneInputs(17);
    scenes[5] = { ...scenes[5]!, narration: `${scenes[5]!.narration} and one invented clause` };

    expect(() =>
      planStoryboard({
        approved_narration: narration,
        target_duration_s: 75,
        document: { scenes },
      }),
    ).toThrow(StoryboardMismatchError);
    expect(() =>
      planStoryboard({
        approved_narration: narration,
        target_duration_s: 75,
        document: { scenes },
      }),
    ).toThrow(/narration/);
  });

  it('rejects duplicate or out-of-sequence scene ids', () => {
    const duplicate = sceneInputs(17);
    duplicate[4] = { ...duplicate[4]!, scene_no: duplicate[3]!.scene_no };

    expect(() =>
      planStoryboard({
        approved_narration: narration,
        target_duration_s: 75,
        document: { scenes: duplicate },
      }),
    ).toThrow(/scene_no|scene id/i);

    const outOfOrder = sceneInputs(17);
    outOfOrder[1] = { ...outOfOrder[1]!, scene_no: 'S03' };

    expect(() =>
      planStoryboard({
        approved_narration: narration,
        target_duration_s: 75,
        document: { scenes: outOfOrder },
      }),
    ).toThrow(StoryboardMismatchError);
  });

  it('rejects a scene count outside the target band', () => {
    const twoScenes = sceneInputs(2);

    expect(() =>
      planStoryboard({
        approved_narration: narration,
        target_duration_s: 75,
        document: { scenes: twoScenes },
      }),
    ).toThrow(/scene count/i);
  });

  it('accepts two scenes for a 10 s target', () => {
    const scenes = sceneInputs(2);
    const plan = planStoryboard({
      approved_narration: narration,
      target_duration_s: 10,
      document: { scenes },
    });

    expect(plan.scene_count).toBe(2);
    expect(plan.target_scene_count).toBe(2);
  });
});

describe('US-017 draftScript pipeline', () => {
  const input = {
    series,
    topic: { title: 'Some decisions deserve the slow lane', description: 'A short piece.' },
    references: [reference],
    target_duration_s: 75,
  };

  it('Signal: three malformed payloads stop the job with field + version + retry count', async () => {
    const malformed = structuredClone(QUIET_MACHINES_FIXTURES.script) as unknown as Record<
      string,
      unknown
    >;
    delete malformed.script;
    const generate = vi.fn(async () => structuredClone(malformed));

    const result = await draftScript(input, { generate });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the draft to fail');
    expect(result.failure.failing_field).toBe('script');
    expect(result.failure.schema_version).toBe('script.v2');
    expect(result.failure.retry_count).toBe(3);
    expect(result.failure.blocked_stages).toContain('IM');
    expect(result.failure.blocked_stages).toContain('NA');
  });

  it('recovers when the third attempt is valid and reports the whole draft', async () => {
    let call = 0;
    const generate = vi.fn(async () => {
      call += 1;
      if (call === 1) return { script: '', title: '', description: '', hashtags: [] };
      if (call === 2) return { script: 'Only a script.' };
      return structuredClone(QUIET_MACHINES_FIXTURES.script);
    });

    const result = await draftScript(input, { generate });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.draft.attempts).toBe(3);
    expect(result.draft.schema_version).toBe('script.v2');
    expect(result.draft.eight_gram.pass).toBe(true);
    expect(result.draft.word_budget.within_band).toBe(true);
    expect(result.draft.claims.mode).toBe('creative');
    expect(result.draft.approval_blockers).toEqual([]);
    expect(result.draft.warnings).toEqual([]);
  });

  it('blocks approval when the generated script contains a reference 8-gram', async () => {
    const script = structuredClone(QUIET_MACHINES_FIXTURES.script);
    const borrowed = 'The quiet machine hums in the corner of the studio while the operator';
    script.description = `${script.description} ${borrowed}`;

    const result = await draftScript(input, { generate: async () => structuredClone(script) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.draft.eight_gram.pass).toBe(false);
    expect(result.draft.approval_blockers.map((blocker) => blocker.code)).toContain('eight_gram');
    expect(result.draft.eight_gram.violation_strings.length).toBeGreaterThan(0);
  });

  it('blocks approval in factual mode while a claim has no accepted source', async () => {
    const result = await draftScript(
      {
        ...input,
        series: { mode: 'factual', niche: 'psychology' },
        claims: [{ text: 'Most founders quit in month nine.', is_factual: true }],
        sources: [],
      },
      { generate: async () => structuredClone(QUIET_MACHINES_FIXTURES.script) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.draft.claims.all_resolved).toBe(false);
    expect(result.draft.approval_blockers.map((blocker) => blocker.code)).toContain(
      'unresolved_claims',
    );
  });

  it('warns, but does not block, when the narration is outside the word band', async () => {
    const script = structuredClone(QUIET_MACHINES_FIXTURES.script);
    script.script = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');

    const result = await draftScript(input, { generate: async () => structuredClone(script) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a draft');
    expect(result.draft.word_budget.within_band).toBe(false);
    expect(result.draft.warnings.join(' ')).toContain('word');
    expect(result.draft.approval_blockers.map((blocker) => blocker.code)).not.toContain(
      'word_budget',
    );
  });

  it('never generates when the reference set is invalid', async () => {
    const generate = vi.fn(async () => structuredClone(QUIET_MACHINES_FIXTURES.script));

    await expect(draftScript({ ...input, references: [] }, { generate })).rejects.toThrow(
      ReferenceSetError,
    );
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('B-04 fixture integration — the canonical storyboard is a split of the fixture script', () => {
  it('plans the 17-scene fixture against the fixture script without a provider call', () => {
    const plan = planStoryboard({
      approved_narration: spokenNarration(QUIET_MACHINES_FIXTURES.script),
      target_duration_s: 75,
      document: QUIET_MACHINES_FIXTURES.storyboard,
    });

    expect(plan.scene_count).toBe(17);
    expect(plan.narration_word_count).toBe(231);
    expect(plan.band).toEqual({ min: 14, max: 20 });
  });
});

describe('punctuation rule: no em dashes', () => {
  it('finds an em dash or an en dash in the script', () => {
    expect(dashOffender({ script: 'Silence — not speech.' })).toBe('script');
    expect(dashOffender({ script: 'a – b.' })).toBe('script');
    expect(dashOffender({ script: 'a, b. c.' })).toBeNull();
  });

  it('rewrites a dash as the comma or stop a reader expects', () => {
    expect(stripForbiddenDashes('composure — not volume — is quiet')).toBe(
      'composure, not volume, is quiet',
    );
    expect(stripForbiddenDashes('he paused — then left.')).toBe('he paused, then left.');
    expect(stripForbiddenDashes('no dashes here.')).toBe('no dashes here.');
  });

  it('says the rule in the script prompt as well', () => {
    const prompt = buildScriptPrompt({
      series,
      topic: {
        title: 'Some decisions deserve the slow lane',
        description: 'Why reversible choices are the cheap ones.',
        rationale: 'Fits the series premise.',
      },
      references: [reference],
      target_duration_s: 75,
    });
    expect(promptText(prompt)).toContain('Never use an em dash');
  });
});

describe('one script field', () => {
  it('speaks the script and nothing else', () => {
    expect(spokenNarration({ script: '  Open strong. Land clean.  ' })).toBe(
      'Open strong. Land clean.',
    );
  });

  it('asks for one number, in the one field that is counted', () => {
    const prompt = buildScriptPrompt({
      series,
      topic: {
        title: 'Some decisions deserve the slow lane',
        description: 'Why reversible choices are the cheap ones.',
        rationale: 'Fits the series premise.',
      },
      references: [reference],
      target_duration_s: 75,
    });
    const text = promptText(prompt);
    // One target, stated once, against the field that exists.
    expect(text).toContain('write one continuous script of 228 words');
    expect(text).toContain('COUNT the words before you answer');
    // The three-field contract is gone: no per-part targets, no field names to divide.
    expect(text).not.toContain('hook: one sentence, about');
    expect(text).not.toContain('COUNT hook + narration + ending together');
    expect(prompt.schema_version).toBe('script.v2');
  });

  it('names the one field in the schema it sends', () => {
    const prompt = buildScriptPrompt({
      series,
      topic: {
        title: 'Some decisions deserve the slow lane',
        description: 'Why reversible choices are the cheap ones.',
        rationale: 'Fits the series premise.',
      },
      references: [reference],
      target_duration_s: 75,
    });
    const text = promptText(prompt);
    expect(text).toContain('"script"');
    expect(text).not.toContain('"hook"');
    expect(text).not.toContain('"narration"');
  });
});
