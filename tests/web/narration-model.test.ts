import { describe, expect, it } from 'vitest';

import { NarrationViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  ACCEPT_OUT_OF_BAND_REASON,
  ACCEPT_UNWIRED_REASON,
  bandView,
  formatSeconds,
  formatTargetSeconds,
  formatTransportTime,
  narrationModel,
  wordIndexAt,
  wordsView,
  type NarrationView,
} from '../../src/web/narration/model.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';

/**
 * S-14's derivations — US-021 (audio + request id), US-022 (derived timings,
 * duration band, return to review) and R-009-3/4.
 *
 * Every number here is a pure function of the frozen contract's
 * `NarrationViewSchema` fields; nothing invents a provider fact. The fixture
 * carries 4 sample words against a 228-word count, which is exactly the case
 * the coverage line must not overstate.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const base: NarrationView = NarrationViewSchema.parse(FIXTURES['audio.get']);

/** The fixture arrives already accepted; most states below are about a fresh take. */
const unaccepted: NarrationView = view({ accepted_at: null });

function view(overrides: Partial<NarrationView> = {}): NarrationView {
  return { ...base, ...overrides };
}

function withStage(code: string, overrides: Record<string, unknown>): VideoDetail {
  return {
    ...detail,
    stages: detail.stages.map((stage) =>
      stage.stage === code ? { ...stage, ...overrides } : stage,
    ),
  } as VideoDetail;
}

describe('number formatting (UI_SPEC §9.6)', () => {
  it('prints durations with one decimal and s', () => {
    expect(formatSeconds(75.1)).toBe('75.1 s');
    expect(formatSeconds(75)).toBe('75.0 s');
    expect(formatSeconds(9.44)).toBe('9.4 s');
  });

  it('prints a target as an integer when it is one', () => {
    expect(formatTargetSeconds(75)).toBe('75 s');
    expect(formatTargetSeconds(75.5)).toBe('75.5 s');
    expect(formatTargetSeconds(10)).toBe('10 s');
  });

  it('prints the audio transport as mm:ss.s', () => {
    expect(formatTransportTime(0)).toBe('00:00.0');
    expect(formatTransportTime(220)).toBe('00:00.2');
    expect(formatTransportTime(75_490)).toBe('01:15.4');
    expect(formatTransportTime(312_000)).toBe('05:12.0');
    expect(formatTransportTime(-5)).toBe('00:00.0');
  });
});

describe('duration vs the ±5 % band (R-009-3)', () => {
  it('reports an in-band take with the contract band, tolerance and deviation', () => {
    const band = bandView(base);
    expect(band.withinBand).toBe(true);
    expect(band.actualLabel).toBe('75.1 s');
    expect(band.targetLabel).toBe('75 s');
    expect(band.bandLabel).toBe('71.3–78.8 s');
    expect(band.toleranceLabel).toBe('±3.8 s (±5%)');
    expect(band.deviationLabel).toBe('+0.1 s (+0.1%)');
    expect(band.verdict).toBe('Within band');
    expect(band.sentence).toBeNull();
  });

  it('states a miss with the UX A-19 sentence and no time-stretch claim', () => {
    const out = bandView(
      view({ duration_s: 79.1, band: { min_s: 71.3, max_s: 78.8, within_band: false } }),
    );
    expect(out.withinBand).toBe(false);
    expect(out.verdict).toBe('Outside band');
    expect(out.deviationLabel).toBe('+4.1 s (+5.5%)');
    expect(out.sentence).toBe(
      'Actual 79.1 s vs target 75 s = +5.5%, outside ±5%. ' +
        'The video returned to script review; speech was not time-stretched.',
    );
  });

  it('names the ±1 s clamp for a short target instead of claiming ±5 %', () => {
    const short = bandView(
      view({
        duration_s: 9.4,
        target_duration_s: 10,
        band: { min_s: 9, max_s: 11, within_band: false },
      }),
    );
    expect(short.toleranceLabel).toBe('±1.0 s (clamped to at least ±1 s)');
    expect(short.sentence).toBe(
      'Actual 9.4 s vs target 10 s = -6.0%, outside ±1.0 s (the ±1 s clamp for a 10 s target). ' +
        'The video returned to script/voice review; the speech was not time-stretched (R-009-4).',
    );
  });

  it('has no duration line before a take exists', () => {
    const band = bandView(view({ duration_s: null, asset: null, words: [] }));
    expect(band.actualLabel).toBeNull();
    expect(band.deviationLabel).toBeNull();
    expect(band.verdict).toBe('No take yet');
  });
});

describe('derived word timings (US-022)', () => {
  it('does not overstate coverage when fewer words are timed than counted', () => {
    const words = wordsView(base);
    expect(words.derivedWords).toBe(4);
    expect(words.totalWords).toBe(228);
    expect(words.coverageLine).toBe('4 of 228 words timed (1.8%)');
    expect(words.monotonic).toBe(true);
    expect(words.monotonicLine).toBeNull();
  });

  it('says all timed when the derived list matches the word count', () => {
    const words = [0, 1, 2].map((index) => ({
      word: 'w' + index,
      start_ms: index * 200,
      end_ms: index * 200 + 200,
    }));
    const result = wordsView(view({ words, word_count: 3 }));
    expect(result.coverageLine).toBe('3 words · all timed');
  });

  it('labels each row with a transport start and a one-decimal span', () => {
    const words = wordsView(base);
    expect(words.rows[0]).toEqual({
      index: 0,
      word: 'You',
      startMs: 0,
      endMs: 220,
      startLabel: '00:00.0',
      spanLabel: '0.2 s',
    });
    expect(words.firstLabel).toBe('00:00.0');
    expect(words.lastLabel).toBe('00:00.9');
  });

  it('flags non-monotonic timings rather than hiding them', () => {
    const words = [
      { word: 'one', start_ms: 0, end_ms: 300 },
      { word: 'two', start_ms: 200, end_ms: 500 },
    ];
    const result = wordsView(view({ words, word_count: 2 }));
    expect(result.monotonic).toBe(false);
    expect(result.monotonicLine).toContain('not monotonic');
    expect(result.monotonicLine).toContain('word 2');
  });

  it('maps a playback position to the word being spoken', () => {
    const rows = wordsView(base).rows;
    expect(wordIndexAt(rows, -1)).toBe(-1);
    expect(wordIndexAt(rows, 0)).toBe(0);
    expect(wordIndexAt(rows, 219)).toBe(0);
    expect(wordIndexAt(rows, 220)).toBe(1);
    expect(wordIndexAt(rows, 600)).toBe(3);
    expect(wordIndexAt(rows, 940)).toBe(3);
    expect(wordIndexAt([], 100)).toBe(-1);
  });
});

describe('surface states (UX_SPEC S-14 row)', () => {
  it('renders a ready take in band, with the asset href and provenance', () => {
    const model = narrationModel({
      detail,
      narration: unaccepted,
      alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
      acceptWired: true,
    });
    expect(model.state).toBe('ready');
    expect(model.chip).toBe('done');
    expect(model.chipLabel).toBe('Within band');
    expect(model.heading).toBe('Narration and timing');
    expect(model.summaryLine).toBe('228 words · 75.1 s · 71.3–78.8 s');
    expect(model.assetHref).toBe(base.asset?.urls.full);
    expect(model.accept.enabled).toBe(true);
    expect(model.accept.reason).toBeNull();
    expect(model.rerun.enabled).toBe(true);
    expect(model.alignmentLines).toContainEqual(['Request id', 'req_000000000001']);
  });

  it('cannot send accept while the contract exposes no alignment id (gap S-14-1)', () => {
    const model = narrationModel({
      detail,
      narration: unaccepted,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.accept.enabled).toBe(false);
    expect(model.accept.reason).toBe(ACCEPT_UNWIRED_REASON);
  });

  it('cannot send accept when the gateway has no accept seam', () => {
    const model = narrationModel({
      detail,
      narration: unaccepted,
      alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
      acceptWired: false,
    });
    expect(model.accept.enabled).toBe(false);
    expect(model.accept.reason).toBe(ACCEPT_UNWIRED_REASON);
  });

  it('refuses to accept a timing outside the band (R-009-4)', () => {
    const model = narrationModel({
      detail,
      narration: view({
        duration_s: 79.1,
        accepted_at: null,
        band: { min_s: 71.3, max_s: 78.8, within_band: false },
      }),
      alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
      acceptWired: true,
    });
    expect(model.state).toBe('out_of_band');
    expect(model.chip).toBe('failed');
    expect(model.chipLabel).toBe('Outside band');
    expect(model.accept.enabled).toBe(false);
    expect(model.accept.reason).toBe(ACCEPT_OUT_OF_BAND_REASON);
    expect(model.returnHref).toBe('/videos/' + detail.id + '/script');
  });

  it('shows the accepted record instead of the control', () => {
    const model = narrationModel({
      detail,
      narration: view({ accepted_at: '2026-10-20T09:31:12.000Z' }),
      alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
      acceptWired: true,
    });
    expect(model.accept.enabled).toBe(false);
    expect(model.accept.visible).toBe(false);
    expect(model.accept.acceptedLine).toBe('Timing accepted 2026-10-20T09:31:12Z.');
  });

  it('reports a running narration with the typical latency and no invented duration', () => {
    const model = narrationModel({
      detail: withStage('NA', { state: 'running', progress: { current: 1, total: 1 } }),
      narration: null,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.state).toBe('running');
    expect(model.chip).toBe('running');
    expect(model.summaryLine).toBe('1 TTS call running (11 s typical)');
    expect(model.detailLine).toBe('Attempt 1 of 3.');
    expect(model.rerun.enabled).toBe(false);
    expect(model.rerun.reason).toBe('Narration is already running.');
    expect(model.assetHref).toBeNull();
  });

  it('names the TTS failure class and the attempts used', () => {
    const model = narrationModel({
      detail: withStage('NA', {
        state: 'failed',
        attempts: { count: 3, max_attempts: 3, last_error_class: 'tts_timeout' },
      }),
      narration: null,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.state).toBe('failed');
    expect(model.chip).toBe('failed');
    expect(model.summaryLine).toBe('TTS failed: tts_timeout · 3 of 3 attempts used.');
  });

  it('carries the blocked reason verbatim', () => {
    const model = narrationModel({
      detail: withStage('NA', { state: 'blocked', blocked_reason: 'script unapproved' }),
      narration: null,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.state).toBe('blocked');
    expect(model.summaryLine).toBe('script unapproved');
    expect(model.rerun.visible).toBe(false);
    expect(model.scriptHref).toBe('/videos/' + detail.id + '/script');
  });

  it('uses the UI_SPEC empty line before the script is approved', () => {
    const model = narrationModel({
      detail: withStage('NA', { state: 'not_run', blocked_reason: null }),
      narration: null,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.state).toBe('empty');
    expect(model.chip).toBe('not_run');
    expect(model.emptyLine).toBe('No narration yet. It runs after script approval.');
  });

  it('keeps the stale cause visible and offers a re-run', () => {
    const model = narrationModel({
      detail: withStage('NA', {
        state: 'done',
        stale: true,
        stale_cause: 'script rev 4 → rev 5',
        stale_at: '2026-10-20T09:20:00.000Z',
      }),
      narration: unaccepted,
      alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
      acceptWired: true,
    });
    expect(model.state).toBe('stale');
    expect(model.chip).toBe('stale');
    expect(model.staleLine).toContain('script rev 4 → rev 5');
    expect(model.rerun.enabled).toBe(true);
  });

  it('previews exactly what a re-run will and will not re-run (C-17)', () => {
    const model = narrationModel({
      detail,
      narration: unaccepted,
      alignmentId: null,
      acceptWired: true,
    });
    expect(model.rerun.callLine).toBe('1 TTS call');
    expect(model.rerun.scopeLine).toBe(
      'Retry will re-run narration (1 TTS call), timing and the render (1 pass). ' +
        'It will not re-run the 17 images, the approved script, the storyboard or the research. ' +
        'Retrying reuses every stored asset: no new provider call is made for a completed stage.',
    );
  });
});
