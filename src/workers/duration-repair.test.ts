import { describe, expect, it } from 'vitest';

import {
  buildTrimMessages,
  countWords,
  deriveTargetWords,
  trimSentencesToFit,
  rebuildPlan,
  sceneCarryovers,
  MIN_SCENE_WORDS,
} from './duration-repair.js';
import type { ScriptDocument } from '../domain/authoring.js';

function document(overrides: Partial<ScriptDocument> = {}): ScriptDocument {
  return {
    script:
      'Nobody tells you this. Composure is not silence. It is the pause that makes people lean in. That is the whole trick.',
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
    const messages = buildTrimMessages({
      document: doc,
      currentWords: 232,
      targetWords: 181,
      sceneCount: 17,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toContain('Cut 51 words');
    // Countable, per scene: 181 ÷ 17 ≈ 11, which is what the model can check itself.
    expect(messages[1]!.content).toContain('17 scenes of about 11 words each');
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
      script:
        'Composure is not silence and it never was. It is the pause that makes a room lean in. ' +
        'A pause works only when the room expects you to fill it. That is the whole trick and nothing more.',
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
    const tooShort = document({ script: 'One two. Three four. Five six.' });

    expect(() =>
      rebuildPlan({ plan: source, carryovers, document: tooShort, targetDurationS: 75 }),
    ).toThrow(/scene/i);
  });

  it('balances the scenes by word count, so no shot is a fragment', () => {
    // A sentence-boundary split gave S01 a one-word scene here; word-balanced cuts
    // give two equal shots instead.
    const source = plan(2, 10);
    const carryovers = sceneCarryovers(source);
    const doc = document({
      script:
        'Composure is not silence and it never was. It is the pause that makes a room lean in and hold. ' +
        'That is the trick of it.',
    });

    const rebuilt = rebuildPlan({
      plan: source,
      carryovers,
      document: doc,
      targetDurationS: 75,
    });
    const scenes = rebuilt.document.scenes as {
      word_count: number;
      start_word: number;
      end_word: number;
    }[];
    expect(scenes).toHaveLength(2);
    for (const scene of scenes) {
      expect(scene.word_count).toBeGreaterThanOrEqual(MIN_SCENE_WORDS);
    }
    // Contiguous from zero: TC compares these ranges against the spoken words.
    expect(scenes[0]!.start_word).toBe(0);
    expect(scenes[0]!.end_word).toBe(scenes[1]!.start_word);
    expect(scenes[1]!.end_word).toBe(rebuilt.word_count);
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

describe('duration repair — the hard backstop', () => {
  it('counts words the way the budget does', () => {
    expect(countWords('  one two   three ')).toBe(3);
    expect(countWords('')).toBe(0);
  });

  it('shortens the longest sentences until the script fits, keeping the open and the close', () => {
    const doc = document({
      script:
        'Composure is not silence. It is the pause that makes a room lean in. ' +
        'A much longer sentence that keeps going and going and going well past any useful length for a reel. ' +
        'That is the trick.',
    });
    // The floor is MIN_SCENE_WORDS per sentence, so this is the tightest it can become.
    const fitted = trimSentencesToFit(doc, 30);
    expect(countWords(fitted.script)).toBeLessThanOrEqual(30);
    // The first sentence is the hook and the last is the landing: the video opens and
    // closes on them, so they survive the cut.
    expect(fitted.script.startsWith('Composure is not silence.')).toBe(true);
    expect(fitted.script.endsWith('That is the trick.')).toBe(true);
    // The cut takes the tail off the longest sentence, so the padding is what goes.
    expect(fitted.script).not.toContain('well past any useful length');
    // No interior sentence below the floor: that is what produced a one-word scene.
    // The hook and the landing are short by nature and are not scenes of their own.
    const sentences = fitted.script.match(/[^.!?]+[.!?]+/g) ?? [];
    for (const sentence of sentences.slice(1, -1)) {
      expect(countWords(sentence)).toBeGreaterThanOrEqual(6);
    }
  });

  it('leaves a document that already fits untouched', () => {
    const doc = document({ script: 'One two. Three four. Five six.' });
    expect(trimSentencesToFit(doc, 100)).toEqual(doc);
  });
});
