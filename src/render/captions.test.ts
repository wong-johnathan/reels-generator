import { describe, expect, it } from 'vitest';

import {
  CAPTION_OUTLINE_PX,
  CAPTION_SHADOW_PX,
  CaptionOverflowError,
  assMargins,
  assTimestamp,
  buildAssDocument,
  buildCaptionDocuments,
  buildSrtDocument,
  buildVttDocument,
  captionMaxCharsPerLine,
  captionSafeArea,
  groupCaptionCuesByWord,
  captionTextWidthPx,
  estimateTextWidthPx,
  groupCaptionCues,
  offsetCues,
  sanitizeCaptionText,
  srtTimestamp,
  vttTimestamp,
} from './captions.js';
import { CAPTION_BLOCK_BOTTOM_RATIO, CAPTION_FONT_SIZE } from './constants.js';

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

  it('derives the caption text-box width as the safe width minus the ink pad', () => {
    const pad = CAPTION_OUTLINE_PX + CAPTION_SHADOW_PX;
    expect(captionTextWidthPx()).toBe(1026 - 54 - 2 * pad);
    expect(captionTextWidthPx()).toBe(960);
  });

  it('anchors the ink bottom at 75% and insets the horizontal margins by outline + shadow', () => {
    const safe = captionSafeArea();
    const margins = assMargins(safe);
    const pad = CAPTION_OUTLINE_PX + CAPTION_SHADOW_PX;
    const inkBottom = Math.round(safe.height * CAPTION_BLOCK_BOTTOM_RATIO);
    expect(margins.left).toBe(safe.left + pad);
    expect(margins.right).toBe(safe.width - safe.right + pad);
    // The ASS bottom margin is measured to the text box, one ink pad above 75%.
    expect(margins.vertical).toBe(safe.height - (inkBottom - pad));
    expect(inkBottom).toBe(1440);
    // The text box bottom is clear of the bottom 25% of the frame.
    expect(safe.height - margins.vertical + pad).toBeLessThanOrEqual(1440);
  });

  it('keeps a representative full reel line inside the safe width at 68 px', () => {
    const line = 'quiet machine runs'; // a typical one-liner
    expect(estimateTextWidthPx(line)).toBeLessThanOrEqual(captionTextWidthPx());
  });

  it('derives a per-line character budget from the font size', () => {
    expect(CAPTION_FONT_SIZE).toBe(68);
    expect(captionMaxCharsPerLine()).toBe(24);
    // A smaller font fits more characters on the same width.
    expect(captionMaxCharsPerLine(48)).toBeGreaterThan(captionMaxCharsPerLine(68));
  });
});

describe('cue grouping', () => {
  it('groups words into cues of at most two lines and never exceeds the width budget', () => {
    const cues = groupCaptionCues(words(Array.from({ length: 40 }, (_, index) => `word${index}`)));
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) {
        expect(line.length).toBeLessThanOrEqual(captionMaxCharsPerLine());
        expect(estimateTextWidthPx(line)).toBeLessThanOrEqual(captionTextWidthPx());
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

  it('authors the ASS with the 68 px style anchored at 75% inside the safe area', () => {
    const ass = buildAssDocument(cues);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('WrapStyle: 2');
    expect(ass).toContain('Style: ReelsCaption,DejaVu Sans,68');
    // BorderStyle 1 (outline + shadow), Outline 3, Shadow 3, Alignment 2, margins.
    expect(ass).toContain('1,3,3,2,60,60,486,1');
    expect(ass).not.toMatch(/\\(?:fad|fade)\s*\(/);
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(cues.length);
    expect(dialogues[0]).toContain(',,the');
  });

  it('emits adjacent word cues as immediate full-opacity replacements', () => {
    const wordCues = groupCaptionCuesByWord([
      { word: 'he', start_ms: 0, end_ms: 420 },
      { word: 'said', start_ms: 420, end_ms: 540 },
    ]);
    expect(wordCues[0]!.end_ms).toBe(wordCues[1]!.start_ms);

    const ass = buildAssDocument(wordCues);
    expect(ass).not.toMatch(/\\(?:fad|fade)\s*\(/);
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues[0]).toContain('0:00:00.00,0:00:00.42');
    expect(dialogues[1]).toContain('0:00:00.42,0:00:00.54');
  });

  it('uses \\\\N for the second line of a two-line cue', () => {
    const tight = groupCaptionCues(words(['one', 'two', 'three', 'four', 'five', 'six']), {
      maxCharsPerLine: 6,
    });
    const ass = buildAssDocument(tight);
    expect(ass).toContain('\\N');
  });

  it('refuses a cue whose line is too wide for the text box', () => {
    const long = 'supercalifragilisticexpialidociousandthensome';
    expect(() =>
      buildAssDocument([{ index: 1, start_ms: 0, end_ms: 1000, lines: [long] }]),
    ).toThrow(CaptionOverflowError);
    // A normal two-line cue is authored without throwing.
    expect(() => buildAssDocument(cues)).not.toThrow();
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

describe('one word per cue (operator style)', () => {
  const words = [
    { word: 'Composure', start_ms: 0, end_ms: 420 },
    { word: 'is', start_ms: 420, end_ms: 540 },
    { word: 'not', start_ms: 540, end_ms: 700 },
    { word: 'silence.', start_ms: 700, end_ms: 1100 },
  ];

  it('gives every word its own cue', () => {
    const cues = groupCaptionCuesByWord(words);
    expect(cues).toHaveLength(4);
    expect(cues.map((cue) => cue.lines)).toEqual([['Composure'], ['is'], ['not'], ['silence.']]);
  });

  it('holds each word until the next one starts, so the caption never blinks off', () => {
    const cues = groupCaptionCuesByWord(words);
    // 'is' ends at 540 in the alignment but stays up until 'not' begins.
    expect(cues[1]!.start_ms).toBe(420);
    expect(cues[1]!.end_ms).toBe(540);
    expect(cues[3]!.start_ms).toBe(700);
    expect(cues[3]!.end_ms).toBe(1100);
  });

  it('never lets one cue overlap the next', () => {
    const overlapping = [
      { word: 'a', start_ms: 0, end_ms: 900 },
      { word: 'b', start_ms: 400, end_ms: 800 },
    ];
    const cues = groupCaptionCuesByWord(overlapping);
    expect(cues[0]!.end_ms).toBeLessThanOrEqual(cues[1]!.start_ms);
  });

  it('is what buildCaptionDocuments emits by default, offset by the lead', () => {
    const built = buildCaptionDocuments({ words, leadS: 0.5 });
    expect(built.cues).toHaveLength(4);
    expect(built.cues[0]!.start_ms).toBe(500);
    expect(built.documents.ass).toContain('Composure');
    expect(built.documents.srt).toContain('silence.');
  });

  it('still offers the grouped block when asked', () => {
    const built = buildCaptionDocuments({ words, leadS: 0, mode: 'grouped' });
    expect(built.cues.length).toBeLessThan(4);
  });
});
