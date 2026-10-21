import { describe, expect, it } from 'vitest';

import { NarrationViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { NARRATION_SCRIPTS, renderNarrationPanel } from '../../src/web/render/narration.js';
import {
  ACCEPT_OUT_OF_BAND_REASON,
  ACCEPT_UNWIRED_REASON,
  EMPTY_LINE,
  type NarrationView,
} from '../../src/web/narration/model.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, findAll, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * S-14 server render — US-021 (audio + request id), US-022 (derived timings,
 * duration vs band, return to review), UX_SPEC A-18/A-19, R-009-3/4.
 *
 * The panel must be complete without JavaScript: the player, the transcript,
 * the band, the verdict and the two actions are all in the markup, and the
 * enhancer only adds word-following and seeking.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: NarrationView = NarrationViewSchema.parse(FIXTURES['audio.get']);
const ALIGNMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';

function view(overrides: Partial<NarrationView> = {}): NarrationView {
  return { ...fixture, accepted_at: null, ...overrides };
}

function withStage(code: string, overrides: Record<string, unknown>): VideoDetail {
  return {
    ...detail,
    stages: detail.stages.map((stage) =>
      stage.stage === code ? { ...stage, ...overrides } : stage,
    ),
  } as VideoDetail;
}

function render(input: {
  narration?: NarrationView | null;
  detail?: VideoDetail;
  alignmentId?: string | null;
  acceptWired?: boolean;
  notice?: { kind: 'success' | 'error' | 'info'; message: string } | null;
}): HtmlNode {
  return parseHtml(
    renderNarrationPanel({
      detail: input.detail ?? detail,
      narration: input.narration === undefined ? view() : input.narration,
      alignmentId: input.alignmentId === undefined ? ALIGNMENT_ID : input.alignmentId,
      acceptWired: input.acceptWired ?? true,
      ...(input.notice === undefined ? {} : { notice: input.notice }),
    }),
  );
}

const panel = (page: HtmlNode): HtmlNode => {
  const found = byId(page, 'narration');
  if (found === undefined) throw new Error('no narration panel');
  return found;
};

describe('a ready take (UX_SPEC S-14 success state)', () => {
  it('renders the player, its transcript link and the transport readout', () => {
    const page = render({});
    const audio = byTag(page, 'audio')[0];
    expect(audio).toBeDefined();
    expect(audio?.attrs['src']).toBe(fixture.asset?.urls.full);
    expect(audio?.attrs['controls']).toBe('');
    expect(audio?.attrs['preload']).toBe('metadata');
    expect(audio?.attrs['autoplay']).toBeUndefined();
    expect(audio?.attrs['aria-label']).toBe('Narration, 75.1 seconds');

    const transcript = byTag(page, 'a').find((node) => node.attrs['href'] === '#narration-timings');
    expect(transcript).toBeDefined();
    expect(textOf(transcript as HtmlNode)).toBe('Transcript — 228 words with timings');
    expect(byId(page, 'narration-timings')).toBeDefined();

    const position = findAll(page, (node) => node.attrs['data-narration-position'] !== undefined);
    expect(position).toHaveLength(1);
    expect(textOf(position[0] as HtmlNode)).toBe('00:00.0');
  });

  it('renders the derived word timings as a captioned table with row hooks', () => {
    const page = render({});
    const table = findAll(page, (node) => node.attrs['data-narration-words'] !== undefined)[0];
    expect(table).toBeDefined();
    const caption = byTag(table as HtmlNode, 'caption')[0];
    expect(textOf(caption as HtmlNode)).toBe(
      'Derived word timings — 228 words, from the character alignment.',
    );
    const headers = byTag(table as HtmlNode, 'th');
    expect(headers.slice(0, 3).map((node) => node.attrs['scope'])).toEqual(['col', 'col', 'col']);
    expect(headers.slice(3).map((node) => node.attrs['scope'])).toEqual([
      'row',
      'row',
      'row',
      'row',
    ]);
    expect(headers.slice(0, 3).map((node) => textOf(node))).toEqual(['Start', 'Word', 'Span']);

    const rows = byTag(table as HtmlNode, 'tr').filter(
      (node) => node.attrs['data-word-index'] !== undefined,
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]?.attrs['data-word-start']).toBe('0');
    expect(rows[0]?.attrs['data-word-end']).toBe('220');
    const cells = byTag(rows[0] as HtmlNode, 'td');
    expect(cells.map((node) => textOf(node))).toEqual(['00:00.0', '0.2 s']);
    expect(textOf(byTag(rows[0] as HtmlNode, 'th')[0] as HtmlNode)).toBe('You');
  });

  it('states coverage honestly and the band numbers it was given', () => {
    const page = render({});
    const text = textOf(panel(page));
    expect(text).toContain('4 of 228 words timed (1.8%)');
    expect(text).toContain('Within band');
    const values = findAll(page, (node) => node.tag === 'dd').map((node) => textOf(node));
    expect(values).toContain('75.1 s');
    expect(values).toContain('75 s');
    expect(values).toContain('71.3–78.8 s');
    expect(values).toContain('±3.8 s (±5%)');
    expect(values).toContain('+0.1 s (+0.1%)');
  });

  it('names the alignment provider, model and request id (US-021)', () => {
    const page = render({});
    const text = textOf(panel(page));
    expect(text).toContain('elevenlabs');
    expect(text).toContain('convert-with-timestamps');
    expect(text).toContain('req_000000000001');
  });

  it('posts accept with the alignment id the seam supplies', () => {
    const page = render({});
    const form = byTag(page, 'form').find(
      (node) => node.attrs['action'] === '/videos/' + detail.id + '/audio/accept',
    );
    expect(form).toBeDefined();
    expect(form?.attrs['method']).toBe('post');
    const hidden = byTag(form as HtmlNode, 'input').find(
      (node) => node.attrs['name'] === 'alignment_id',
    );
    expect(hidden?.attrs['value']).toBe(ALIGNMENT_ID);
    expect(hidden?.attrs['type']).toBe('hidden');
  });

  it('previews the re-run cost behind a disclosure, C-17 verbatim', () => {
    const page = render({});
    const details = byTag(page, 'details')[0];
    expect(details).toBeDefined();
    const summary = byTag(details as HtmlNode, 'summary')[0];
    expect(textOf(summary as HtmlNode)).toBe('Re-run narration (1 TTS call)');
    const text = textOf(details as HtmlNode);
    expect(text).toContain(
      'Retry will re-run narration (1 TTS call), timing and the render (1 pass). ' +
        'It will not re-run the 17 images, the approved script, the storyboard or the research.',
    );
    expect(text).toContain('no new provider call is made for a completed stage');
    const forms = byTag(details as HtmlNode, 'form');
    expect(forms[0]?.attrs['action']).toBe('/videos/' + detail.id + '/audio/rerun');
    expect(forms[0]?.attrs['method']).toBe('post');
    const submit = byTag(details as HtmlNode, 'button').find(
      (node) => node.attrs['type'] === 'submit',
    );
    expect(textOf(submit as HtmlNode)).toBe('Re-run narration · 1 TTS call');
  });

  it('offers no accept when the endpoint exposes no alignment id (gap S-14-1)', () => {
    const page = render({ alignmentId: null });
    const accept = byId(page, 'narration-accept');
    expect(accept?.attrs['data-accept']).toBe('unwired');
    expect(textOf(accept as HtmlNode)).toContain(ACCEPT_UNWIRED_REASON);
    const button = byTag(accept as HtmlNode, 'button')[0];
    expect(button?.attrs['disabled']).toBe('');
    expect(byTag(accept as HtmlNode, 'form')).toHaveLength(0);
  });

  it('shows the accepted record instead of the control', () => {
    const page = render({ narration: view({ accepted_at: '2026-10-20T09:31:12.000Z' }) });
    const accept = byId(page, 'narration-accept');
    expect(accept?.attrs['data-accept']).toBe('accepted');
    expect(textOf(accept as HtmlNode)).toContain('Timing accepted 2026-10-20T09:31:12Z.');
    expect(byTag(accept as HtmlNode, 'form')).toHaveLength(0);
  });
});

describe('a timing miss (UX_SPEC A-19, R-009-4)', () => {
  const outOfBand = view({
    duration_s: 79.1,
    band: { min_s: 71.3, max_s: 78.8, within_band: false },
  });

  it('prints the A-19 sentence and the return-to-review link, never a stretch claim', () => {
    const page = render({ narration: outOfBand });
    const text = textOf(panel(page));
    expect(text).toContain(
      'Actual 79.1 s vs target 75 s = +5.5%, outside ±5%. ' +
        'The video returned to script review; speech was not time-stretched.',
    );
    expect(text).not.toContain('time-stretched to');
    const link = byTag(page, 'a').find(
      (node) => node.attrs['href'] === '/videos/' + detail.id + '/script',
    );
    expect(textOf(link as HtmlNode)).toBe('Return to script review');
    expect(panel(page).attrs['data-state']).toBe('out_of_band');
  });

  it('refuses accept with the R-009-4 reason and keeps the audio playable', () => {
    const page = render({ narration: outOfBand });
    const accept = byId(page, 'narration-accept');
    expect(accept?.attrs['data-accept']).toBe('out_of_band');
    expect(textOf(accept as HtmlNode)).toContain(ACCEPT_OUT_OF_BAND_REASON);
    expect(byTag(page, 'audio')).toHaveLength(1);
    expect(textOf(panel(page))).toContain('Outside band');
  });
});

describe('states before a take exists', () => {
  it('uses the UI_SPEC empty line and links to the script', () => {
    const page = render({
      narration: null,
      detail: withStage('NA', { state: 'not_run', blocked_reason: null }),
    });
    expect(panel(page).attrs['data-state']).toBe('empty');
    expect(textOf(panel(page))).toContain(EMPTY_LINE);
    expect(textOf(panel(page))).toContain(
      'Approving the script unlocks the image stage and 1 TTS call.',
    );
    expect(byTag(page, 'audio')).toHaveLength(0);
    expect(byTag(page, 'table')).toHaveLength(0);
    const link = byTag(page, 'a').find(
      (node) => node.attrs['href'] === '/videos/' + detail.id + '/script',
    );
    expect(textOf(link as HtmlNode)).toBe('Go to Script');
    expect(byId(page, 'narration-accept')).toBeUndefined();
  });

  it('shows a running TTS call with the attempt count and no fake audio', () => {
    const page = render({
      narration: null,
      detail: withStage('NA', {
        state: 'running',
        progress: { current: 1, total: 1 },
        attempts: { count: 1, max_attempts: 3, last_error_class: null },
      }),
    });
    const text = textOf(panel(page));
    expect(panel(page).attrs['data-state']).toBe('running');
    expect(text).toContain('1 TTS call running (11 s typical)');
    expect(text).toContain('Attempt 1 of 3.');
    expect(text).not.toContain('Approving the script');
    expect(text.split('1 TTS call running (11 s typical)')).toHaveLength(2);
    expect(byTag(page, 'audio')).toHaveLength(0);
    const spend = byId(page, 'narration-spend');
    expect(textOf(spend as HtmlNode)).toContain('Narration is already running.');
    const button = byTag(spend as HtmlNode, 'button').find(
      (node) => node.attrs['type'] === 'submit',
    );
    expect(button?.attrs['disabled']).toBe('');
  });

  it('names the TTS failure class and attempts (UX_SPEC error state)', () => {
    const page = render({
      narration: null,
      detail: withStage('NA', {
        state: 'failed',
        attempts: { count: 3, max_attempts: 3, last_error_class: 'tts_timeout' },
      }),
    });
    const text = textOf(panel(page));
    expect(panel(page).attrs['data-state']).toBe('failed');
    expect(text).toContain('TTS failed: tts_timeout · 3 of 3 attempts used.');
    expect(text).not.toContain('Approving the script');
    expect(text).toContain('1 TTS call');
  });

  it('carries a blocked reason and a stale cause verbatim', () => {
    const blocked = render({
      narration: null,
      detail: withStage('NA', { state: 'blocked', blocked_reason: 'script unapproved' }),
    });
    expect(blocked.attrs).toBeDefined();
    expect(textOf(panel(blocked))).toContain('Narration is blocked');
    expect(textOf(panel(blocked))).toContain('script unapproved');
    expect(textOf(panel(blocked)).split('script unapproved')).toHaveLength(2);
    expect(textOf(panel(blocked))).toContain('Go to Script');

    const stale = render({
      detail: withStage('NA', {
        state: 'done',
        stale: true,
        stale_cause: 'script rev 4 → rev 5',
        stale_at: '2026-10-20T09:20:00.000Z',
      }),
    });
    expect(panel(stale).attrs['data-state']).toBe('stale');
    expect(textOf(panel(stale))).toContain('script rev 4 → rev 5 · 2026-10-20T09:20:00Z');
  });
});

describe('markup safety and notices', () => {
  it('escapes a word from the provider', () => {
    const page = render({
      narration: view({
        words: [{ word: '<script>alert(1)</script>', start_ms: 0, end_ms: 200 }],
        word_count: 1,
      }),
    });
    const table = findAll(page, (node) => node.attrs['data-narration-words'] !== undefined)[0];
    const wordCell = byTag(table as HtmlNode, 'th').find((node) => node.attrs['scope'] === 'row');
    expect(textOf(wordCell as HtmlNode)).toBe('<script>alert(1)</script>');
    expect(
      renderNarrationPanel({
        detail,
        narration: view({
          words: [{ word: '<script>alert(1)</script>', start_ms: 0, end_ms: 200 }],
          word_count: 1,
        }),
        alignmentId: ALIGNMENT_ID,
        acceptWired: true,
      }),
    ).not.toContain('<script>alert(1)</script>');
  });

  it('renders a notice in a polite status region', () => {
    const page = render({
      notice: { kind: 'success', message: 'Narration re-run queued: 1 TTS call.' },
    });
    const notice = findAll(page, (node) => node.attrs['data-notice'] !== undefined)[0];
    expect(notice?.attrs['role']).toBe('status');
    expect(notice?.attrs['data-notice']).toBe('success');
    expect(textOf(notice as HtmlNode)).toContain('Narration re-run queued: 1 TTS call.');
  });

  it('ships the enhancer module only as a script reference, not inline', () => {
    expect(NARRATION_SCRIPTS).toEqual(['/assets/client/narration.js']);
    expect(
      renderNarrationPanel({ detail, narration: view(), alignmentId: null, acceptWired: true }),
    ).not.toContain('<script');
  });
});
