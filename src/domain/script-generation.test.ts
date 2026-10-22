import { describe, expect, it } from 'vitest';

import { QUIET_MACHINES_FIXTURES } from '../adapters/text-fixtures.js';
import { wordBudget } from '../shared/calibration.js';
import { checkWordBudget, countWords } from './authoring.js';
import {
  assembleScript,
  frameWordCount,
  freezeFrame,
  narrationRepairDelta,
  narrationRestatesHook,
  narrationWordTarget,
  scriptFrameSchema,
  scriptNarrationSchema,
  SC_FRAME_MAX_TOKENS,
  SC_NARRATION_MAX_TOKENS,
  SC_REPAIR_MAX_TOKENS,
} from './script-generation.js';

const frame = () =>
  freezeFrame({
    hook: 'Stop scrolling: this one habit is quietly draining you.',
    ending: 'So pick one, start tonight, and watch the fog lift.',
    title: 'The one habit',
    description: 'A short explainer on a draining habit and how to fix it.',
    hashtags: ['#habits', '#mindset'],
  });

describe('freezeFrame (frame validation)', () => {
  it('freezes every frame field and the copied hashtags at runtime', () => {
    const frozen = frame();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.hashtags)).toBe(true);
    for (const key of ['hook', 'ending', 'title', 'description', 'hashtags'] as const) {
      const before = frozen[key];
      expect(Reflect.set(frozen, key, key === 'hashtags' ? ['#changed'] : 'changed')).toBe(false);
      expect(frozen[key]).toBe(before);
    }
    expect(Reflect.set(frozen.hashtags, '0', '#changed')).toBe(false);
    expect(() => (frozen.hashtags as string[]).push('#changed')).toThrow(TypeError);
    expect(frozen.hashtags).toEqual(['#habits', '#mindset']);
  });

  it('does not alias or freeze the caller-owned hashtags', () => {
    const hashtags = ['#original'];
    const frozen = freezeFrame({
      hook: 'hook',
      ending: 'ending',
      title: 't',
      description: 'd',
      hashtags,
    });
    expect(frozen.hashtags).not.toBe(hashtags);
    hashtags[0] = '#changed';
    hashtags.push('#extra');
    expect(frozen.hashtags).toEqual(['#original']);
  });
  it('strips em/en dashes from the hook and ending', () => {
    const frozen = freezeFrame({
      hook: 'Stop scrolling\u2014this drains you.',
      ending: 'Start tonight\u2013it lifts.',
      title: 't',
      description: 'd',
      hashtags: ['#a'],
    });
    expect(frozen.hook).not.toContain('\u2014');
    expect(frozen.ending).not.toContain('\u2013');
  });

  it('rejects an empty hook after cleaning', () => {
    expect(() =>
      freezeFrame({ hook: '   ', ending: 'ok', title: 't', description: 'd', hashtags: ['#a'] }),
    ).toThrow(/hook is empty/);
  });

  it('rejects an empty ending after cleaning', () => {
    expect(() =>
      freezeFrame({ hook: 'ok', ending: '   ', title: 't', description: 'd', hashtags: ['#a'] }),
    ).toThrow(/ending is empty/);
  });

  it('accepts a valid frame', () => {
    const frozen = frame();
    expect(frozen.hook.length).toBeGreaterThan(0);
    expect(frozen.ending.length).toBeGreaterThan(0);
  });
});

describe('frame validation schemas', () => {
  it('requires a non-empty hook and ending', () => {
    expect(() =>
      scriptFrameSchema.parse({
        hook: '',
        ending: 'x',
        title: 't',
        description: 'd',
        hashtags: ['#a'],
      }),
    ).toThrow();
    expect(() =>
      scriptFrameSchema.parse({
        hook: 'x',
        ending: '',
        title: 't',
        description: 'd',
        hashtags: ['#a'],
      }),
    ).toThrow();
  });

  it('accepts a well-formed narration document', () => {
    expect(scriptNarrationSchema.parse({ narration: 'The middle development.' })).toEqual({
      narration: 'The middle development.',
    });
  });
});

describe('remaining-budget arithmetic', () => {
  it('subtracts the frozen frame words from the exact target', () => {
    const frozen = frame();
    const spent = frameWordCount(frozen);
    const target = wordBudget(75).target_words;
    expect(narrationWordTarget(frozen, 75)).toBe(target - spent);
  });

  it('never drops below one word', () => {
    const huge = freezeFrame({
      hook: Array.from({ length: 120 }, (_, i) => `word${i}`).join(' '),
      ending: Array.from({ length: 120 }, (_, i) => `tail${i}`).join(' '),
      title: 't',
      description: 'd',
      hashtags: ['#a'],
    });
    expect(narrationWordTarget(huge, 75)).toBe(1);
  });

  it('uses the same countWords as the validator (whitespace split)', () => {
    const frozen = freezeFrame({
      hook: '  one   two  three  ',
      ending: 'four five',
      title: 't',
      description: 'd',
      hashtags: ['#a'],
    });
    expect(frameWordCount(frozen)).toBe(5);
  });
});

describe('assembly', () => {
  it('joins hook + narration + ending in order with single spaces', () => {
    const frozen = frame();
    const assembled = assembleScript(frozen, 'Here is the middle of the argument.');
    expect(assembled.script).toBe(
      `${frozen.hook} Here is the middle of the argument. ${frozen.ending}`,
    );
  });

  it('carries title/description/hashtags into the script.v2 document', () => {
    const frozen = frame();
    const assembled = assembleScript(frozen, 'middle');
    expect(assembled.title).toBe('The one habit');
    expect(assembled.description).toContain('explainer');
    expect(assembled.hashtags).toEqual(['#habits', '#mindset']);
  });

  it('omits an empty narration without doubling spaces', () => {
    const frozen = frame();
    const assembled = assembleScript(frozen, '   ');
    expect(assembled.script).toBe(`${frozen.hook} ${frozen.ending}`);
  });
});

describe('middle-only repair', () => {
  it('computes a positive delta when short and a negative delta when long', () => {
    expect(narrationRepairDelta(210, 75)).toBe(18);
    expect(narrationRepairDelta(250, 75)).toBe(-22);
  });

  it('equals the narration delta because hook/ending are frozen', () => {
    const frozen = frame();
    const spent = frameWordCount(frozen);
    const narration = 'x';
    const assembled = countWords(assembleScript(frozen, narration).script);
    const delta = narrationRepairDelta(assembled, 75);
    // The delta is exactly target - (frame words + narration words).
    expect(delta).toBe(wordBudget(75).target_words - assembled);
    expect(delta).toBe(wordBudget(75).target_words - spent - 1);
  });

  it('preserves the frozen frame through a repair (byte-identical)', () => {
    const frozen = frame();
    const before = { hook: frozen.hook, ending: frozen.ending };
    const delta = narrationRepairDelta(210, 75);
    const reassembled = assembleScript(frozen, `expanded middle of ${Math.abs(delta)} more words`);
    expect(reassembled.script.startsWith(before.hook)).toBe(true);
    expect(reassembled.script.endsWith(before.ending)).toBe(true);
    expect(frozen.hook).toBe(before.hook);
    expect(frozen.ending).toBe(before.ending);
  });
});

describe('exact count semantics', () => {
  it.each([
    [216, false],
    [217, true],
    [239, true],
    [240, false],
  ] as const)('validates a constructed %i-word script (R-009-1)', (words, withinBand) => {
    const script = `  ${Array.from({ length: words }, (_, i) => `word${i}`).join(' \n\t ')}  `;
    expect(countWords(script)).toBe(words);
    const check = checkWordBudget(script, 75);
    expect(check.word_count).toBe(countWords(script));
    expect(check.within_band).toBe(withinBand);
    expect(check.budget).toMatchObject({ min_words: 217, max_words: 239, target_words: 228 });
  });
});

describe('no hook duplication', () => {
  it('detects a narration that restates the hook verbatim', () => {
    const frozen = frame();
    expect(narrationRestatesHook(frozen.hook, `${frozen.hook} and then it continues`)).toBe(true);
    expect(narrationRestatesHook(frozen.hook, 'A different opening entirely.')).toBe(false);
  });
});

describe('explicit max_tokens', () => {
  it('declares a ceiling for every request kind', () => {
    expect(SC_FRAME_MAX_TOKENS).toBe(1024);
    expect(SC_NARRATION_MAX_TOKENS).toBe(1536);
    expect(SC_REPAIR_MAX_TOKENS).toBe(1536);
  });
});

describe('fixture round-trip (frame + narration reconstructs script.v2)', () => {
  it('reconstructs the canonical script byte-for-byte', () => {
    const frame = freezeFrame(
      QUIET_MACHINES_FIXTURES.frame as unknown as Parameters<typeof freezeFrame>[0],
    );
    const narration = (QUIET_MACHINES_FIXTURES.narration as { narration: string }).narration;
    const assembled = assembleScript(frame, narration);
    expect(assembled.script).toBe(QUIET_MACHINES_FIXTURES.script.script);
  });
});
