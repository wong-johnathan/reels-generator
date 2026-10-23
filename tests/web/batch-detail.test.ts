import { describe, expect, it } from 'vitest';

import { renderBatchDetail } from '../../src/web/render/batchDetail.js';
import type { BatchDetail, BatchVideoDetail } from '../../src/web/batches/postgres.js';

const NOW = new Date('2026-10-21T20:00:00.000Z');

function video(overrides: Partial<BatchVideoDetail> = {}): BatchVideoDetail {
  return {
    projectId: 'p1',
    position: 1,
    status: 'NEEDS_ATTENTION',
    currentStage: 'T',
    videoAssetId: null,
    topic: null,
    script: null,
    sceneCount: 0,
    failure: null,
    ...overrides,
  };
}

function batch(videos: readonly BatchVideoDetail[]): BatchDetail {
  return {
    id: 'b1',
    ordinal: 2,
    status: 'ACTIVE',
    targetCount: videos.length,
    createdAt: '2026-10-21T19:00:00.000Z',
    seriesId: 's1',
    seriesName: 'The Art of Seduction',
    videos,
  };
}

describe('batch detail page', () => {
  it('shows the generated topic and script the pipeline produced', () => {
    const html = renderBatchDetail({
      now: NOW,
      batch: batch([
        video({
          topic: {
            title: 'Why restraint reads as confidence',
            description: 'The pause before answering does the work.',
            rationale: 'Fits the series premise and needs no factual claims.',
          },
          script: {
            revision: 1,
            wordCount: 228,
            estimatedRuntimeS: 75,
            title: 'The pause that reads as power',
            script: 'Silence is not the absence of an answer. Say less, and mean it.',
            description: 'A short piece on why restraint reads as confidence.',
            hashtags: ['#psychology', '#attraction'],
          },
          sceneCount: 14,
        }),
      ]),
    });

    expect(html).toContain('batch-0002');
    expect(html).toContain('Why restraint reads as confidence');
    expect(html).toContain('The pause before answering does the work.');
    expect(html).toContain('The pause that reads as power');
    expect(html).toContain('228 words');
    expect(html).toContain('~75 s');
    expect(html).toContain('14 scenes');
    expect(html).toContain('#psychology');
  });

  it('links an SB video to the storyboard approval control', () => {
    const html = renderBatchDetail({
      now: NOW,
      batch: batch([video({ currentStage: 'SB', status: 'RUNNING' })]),
    });

    expect(html).toContain('Review storyboard');
    expect(html).toContain('href="/videos/p1/storyboard"');
  });
  it('names the failed stage, its attempt and the provider error', () => {
    const html = renderBatchDetail({
      now: NOW,
      batch: batch([
        video({
          failure: {
            stage: 'T',
            attemptNo: 1,
            attemptStatus: 'failed',
            chargeStatus: 'unbilled',
            runStatus: 'failed',
            errorClass: 'non_retryable',
            message: 'deepseek answered HTTP 401: Authentication Fails',
            at: '2026-10-21T19:30:00.000Z',
          },
        }),
      ]),
    });

    expect(html).toContain('Stage T failed');
    expect(html).toContain('attempt 1');
    expect(html).toContain('non_retryable');
    expect(html).toContain('Authentication Fails');
    expect(html).toContain('action="/batches/b1/regenerate"');
    expect(html).toContain('Regenerate failed videos');
  });

  it('offers no regenerate control when nothing has failed', () => {
    const html = renderBatchDetail({ now: NOW, batch: batch([video({ failure: null })]) });
    expect(html).not.toContain('/regenerate');
    // Nothing generated yet must say so rather than look blank.
    expect(html).toContain('No topic recorded yet');
    expect(html).toContain('No script yet');
  });

  it('confirms how many jobs were requeued', () => {
    const html = renderBatchDetail({ now: NOW, batch: batch([video()]), regenerated: 2 });
    expect(html).toContain('Requeued 2 jobs');
  });

  it('escapes the provider error rather than injecting its markup', () => {
    const html = renderBatchDetail({
      now: NOW,
      batch: batch([
        video({
          failure: {
            stage: 'T',
            attemptNo: 1,
            attemptStatus: 'failed',
            chargeStatus: null,
            runStatus: null,
            errorClass: 'transient',
            message: '<img src=x onerror=alert(1)>',
            at: '2026-10-21T19:30:00.000Z',
          },
        }),
      ]),
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
