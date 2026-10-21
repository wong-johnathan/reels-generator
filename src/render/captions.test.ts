import { describe, expect, it } from 'vitest';

import {
  CAPTION_OUTLINE_PX,
  CAPTION_SHADOW_PX,
  assMargins,
  assTimestamp,
  buildAssDocument,
  buildCaptionDocuments,
  buildSrtDocument,
  buildVttDocument,
  captionSafeArea,
  estimateTextWidthPx,
  groupCaptionCues,
  offsetCues,
  sanitizeCaptionText,
  srtTimestamp,
  vttTimestamp,
} from './captions.js';

function words(
  texts: readonly string[],
  msPerWord = 300,
): { word: string; start_ms: number; end_ms: number }[] {
  return texts.map((word, index) => ({
    word,
    start_ms: index * msPerWord,
    end_ms: index * msPerWord + msPerWord - 40,
  }));
}

describe('caption safe area (R-010-6, D13)', () => {
  it('is the 5% inset rectangle of 1080x1920', () => {
    expect(captionSafeArea()).toEqual({
      left: 54,
      top: 96,
      right: 1026,
      bottom: 1824,
      width: 1080,
      height: 1920,
    });
  });

  it('insets the ASS margins by the outline and shadow so ink, not the text box, is inside', () => {
    const margins = assMargins(captionSafeArea());
    const pad = CAPTION_OUTLINE_PX + CAPTION_SHADOW_PX;
    expect(margins.left).toBe(54 + pad);
    expect(margins.right).toBe(54 + pad);
    expect(margins.vertical).toBe(96 + pad);
  });

  it('keeps an estimate of a full line inside the safe width', () => {
    const line = 'the quiet machine that runs your'; // 34 chars
    expect(estimateTextWidthPx(line)).toBeLessThanOrEqual(1026 - 54);
  });
});

describe('cue grouping', () => {
  it('groups words into cues of at most two lines and never exceeds the width budget', () => {
    const cues = groupCaptionCues(words(Array.from({ length: 40 }, (_, index) => `word${index}`)));
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) {
        expect(line.length).toBeLessThanOrEqual(30);
        expect(estimateTextWidthPx(line)).toBeLessThanOrEqual(1026 - 54);
      }
    }
  });

  it('keeps every word exactly once, in spoken order', () => {
    const input = words(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
    const cues = groupCaptionCues(input, { maxCharsPerLine: 5 });
    const spoken = cues.flatMap((cue) => cue.lines.join(' ').split(' '));
    expect(spoken).toEqual(input.map((word) => word.word));
  });

  it('anchors a cue to its first word start and its last word end', () => {
    const cues = groupCaptionCues(words(['alpha', 'beta']));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start_ms).toBe(0);
    expect(cues[0]!.end_ms).toBe(560);
    expect(cues[0]!.index).toBe(1);
  });

  it('gives an over-long word its own line instead of dropping or truncating it', () => {
    const long = 'supercalifragilisticexpialidociousandthensome';
    const cues = groupCaptionCues(words([long, 'tail']));
    expect(cues[0]!.lines[0]).toBe(long);
    expect(cues.flatMap((cue) => cue.lines).join(' ')).toContain('tail');
  });
});

describe('timestamps', () => {
  it('formats ASS, SRT and VTT clocks', () => {
    expect(assTimestamp(0)).toBe('0:00:00.00');
    expect(assTimestamp(75_120)).toBe('0:01:15.12');
    expect(srtTimestamp(3_723_456)).toBe('01:02:03,456');
    expect(vttTimestamp(3_723_456)).toBe('01:02:03.456');
    expect(srtTimestamp(-10)).toBe('00:00:00,000');
  });
});

describe('documents', () => {
  const cues = groupCaptionCues(
    words(['the', 'quiet', 'machine', 'that', 'runs', 'your', 'morning'], 400),
  );

  it('authors the ASS so the style margins are inside the safe area', () => {
    const ass = buildAssDocument(cues);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('WrapStyle: 2');
    expect(ass).toContain('Style: ReelsCaption,DejaVu Sans,48');
    expect(ass).toContain(',2,60,60,102,1');
    expect(ass).toContain('{\\fad(120,120)}');
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(cues.length);
  });

  it('uses \\\\N for the second line of a two-line cue', () => {
    const tight = groupCaptionCues(words(['one', 'two', 'three', 'four', 'five', 'six']), {
      maxCharsPerLine: 6,
    });
    const ass = buildAssDocument(tight);
    expect(ass).toContain('\\N');
  });

  it('emits .srt and .vtt from the same cue list as the ASS', () => {
    const srt = buildSrtDocument(cues);
    const vtt = buildVttDocument(cues);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt.trim().split('\n\n')).toHaveLength(cues.length);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain(' --> ');
    expect(vtt).not.toContain(',');
  });

  it('strips ASS override syntax and line breaks from caption text', () => {
    expect(sanitizeCaptionText('{\\b1}hi\\there\nnow')).toBe('/b1hi/there now');
  });
});

describe('buildCaptionDocuments', () => {
  it('shifts cues by the audio lead so captions land on the speech', () => {
    const { cues, documents } = buildCaptionDocuments({
      words: words(['first', 'second']),
      leadS: 0.5,
    });
    expect(cues[0]!.start_ms).toBe(500);
    expect(documents.srt).toContain('00:00:00,500 -->');
    expect(documents.ass).toContain('0:00:00.50,');
  });

  it('offsetCues is a pure shift', () => {
    const shifted = offsetCues([{ index: 1, start_ms: 10, end_ms: 20, lines: ['a'] }], 500);
    expect(shifted[0]).toMatchObject({ start_ms: 510, end_ms: 520 });
  });

  it('produces no cues for an empty word list', () => {
    const { cues, documents } = buildCaptionDocuments({ words: [], leadS: 0.5 });
    expect(cues).toHaveLength(0);
    expect(documents.srt).toBe('');
  });
});
