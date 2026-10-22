import { describe, expect, it } from 'vitest';

import {
  buildTrimMessages,
  deriveTargetWords,
  rebuildPlan,
  sceneCarryovers,
  MIN_SCENE_WORDS,
} from './duration-repair.js';
import type { ScriptDocument } from '../domain/authoring.js';

function document(overrides: Partial<ScriptDocument> = {}): ScriptDocument {
  return {
    hook: 'Nobody tells you this.',
    narration: 'Composure is not silence. It is the pause that makes people lean in.',
    ending: 'That is the whole trick.',
    title: 'The silent anchor',
    description: 'A short reel about composure.',
    hashtags: ['#psychology'],
    ...overrides,
  };
}

function plan(sceneCount: number, wordsPerScene = 12) {
  return {
    schema_version: 'storyboard-plan.v1',
    project_id: 'p',
    target_duration_s: 75,
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      scene_no: `S${String(index + 1).padStart(2, '0')}`,
      position: index,
      narration: Array.from({ length: wordsPerScene }, (_, word) => `w${word}`).join(' '),
      word_count: wordsPerScene,
      start_word: index * wordsPerScene,
      end_word: (index + 1) * wordsPerScene,
      estimated_duration_s: 4,
      image_prompt: `prompt ${index}`,
      camera_move: 'slow push',
      caption_emphasis: null,
      fallback_text: null,
    })),
  };
}

describe('duration repair — deriving the target from the take', () => {
  it('uses the measured rate, not the calibration constant', () => {
    // Batch-0016: 232 words took 94.64 s of speech. At that rate, 74 s of speech
    // (75 s target minus 1 s lead/trail) needs ~181 words — not the 228 the
    // 3.035 w/s constant would have asked for.
    expect(deriveTargetWords({ wordCount: 232, measuredAudioS: 94.64, targetAudioS: 74 })).toBe(
      181,
    );
  });

  it('floors and never returns zero for a pathological rate', () => {
    expect(deriveTargetWords({ wordCount: 1, measuredAudioS: 10_000, targetAudioS: 75 })).toBe(1);
  });

  it('refuses a non-positive measurement rather than guessing', () => {
    expect(() =>
      deriveTargetWords({ wordCount: 232, measuredAudioS: 0, targetAudioS: 74 }),
    ).toThrow(RangeError);
    expect(() =>
      deriveTargetWords({ wordCount: 232, measuredAudioS: 94, targetAudioS: 0 }),
    ).toThrow(RangeError);
  });
});

describe('duration repair — the instruction', () => {
  it('names the shortfall and carries the script in front of the model', () => {
    const doc = document();
    const messages = buildTrimMessages({ document: doc, currentWords: 232, targetWords: 181 });
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toContain('Cut roughly 51 words');
    expect(messages[1]!.content).toContain('181');
    // The whole document travels, not a description of it: a trim needs the words.
    expect(messages[1]!.content).toContain(JSON.stringify(doc));
  });
});

describe('duration repair — rebuilding the plan', () => {
  it('carries every scene prompt across and re-ranges the words', () => {
    const source = plan(3, 10);
    const carryovers = sceneCarryovers(source);
    const trimmed = document({
      hook: 'Composure is not silence and it never was.',
      narration:
        'It is the pause that makes a room lean in. A pause works only when the room expects you to fill it.',
      ending: 'That is the whole trick and nothing more.',
    });

    const rebuilt = rebuildPlan({
      plan: source,
      carryovers,
      document: trimmed,
      targetDurationS: 75,
    });

    const scenes = rebuilt.document.scenes as { image_prompt: string; start_word: number }[];
    expect(scenes).toHaveLength(3);
    expect(scenes.map((scene) => scene.image_prompt)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
    // Ranges are contiguous from zero: TC compares them against the spoken words.
    expect(scenes[0]!.start_word).toBe(0);
    expect(rebuilt.word_count).toBeGreaterThanOrEqual(3 * MIN_SCENE_WORDS);
  });

  it('refuses a trim that cannot fill every scene', () => {
    const source = plan(4, 10);
    const carryovers = sceneCarryovers(source);
    const tooShort = document({ hook: 'One two', narration: 'three four', ending: 'five six' });

    expect(() =>
      rebuildPlan({ plan: source, carryovers, document: tooShort, targetDurationS: 75 }),
    ).toThrow(/scene/i);
  });

  it('refuses a scene below the floor even when the total fits', () => {
    const source = plan(2, 10);
    const carryovers = sceneCarryovers(source);
    // Plenty of words overall, but the only sentence break is after "Yes." so the
    // split hands S01 a one-word shot. A caption cannot live there: refuse it.
    const lopsided = document({
      hook: 'Yes.',
      narration: 'composure is a long run of words that never ends with punctuation at all',
      ending: 'and it keeps going to the end of the take',
    });

    expect(() =>
      rebuildPlan({ plan: source, carryovers, document: lopsided, targetDurationS: 75 }),
    ).toThrow(/minimum 6/);
  });
});

describe('duration repair — scene carryovers', () => {
  it('keeps the prompt and camera move, defaulting missing ones to empty strings', () => {
    const carryovers = sceneCarryovers({
      scenes: [
        { scene_no: 'S01', position: 0, image_prompt: 'a', camera_move: 'push' },
        { scene_no: 'S02', position: 1 },
      ],
    });
    expect(carryovers[0]).toMatchObject({ image_prompt: 'a', camera_move: 'push' });
    expect(carryovers[1]).toMatchObject({ image_prompt: '', camera_move: '' });
  });
});
