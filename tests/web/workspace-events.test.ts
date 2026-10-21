import { describe, expect, it } from 'vitest';

import { SseEventSchema } from '../../contract/api.js';
import { SSE_FIXTURE } from '../../contract/mock/fixtures.js';
import {
  applyFeedEvent,
  chipStateForEvent,
  emptyFeedState,
  eventAnnouncement,
  FEED_EVENT_TYPES,
  parseSseEvent,
  ribbonCodes,
  staleCodes,
  type FeedState,
} from '../../src/web/workspace/events.js';

/**
 * The SSE feed's client half (contract `SseEventSchema`, UX IP-05/AX-27).
 *
 * Two rules matter here: the enhancer must accept exactly the contract's five
 * event variants (no more, no fewer) and it must fail closed on anything else —
 * a half-applied event is worse than a dropped frame.
 */

const frame = (value: unknown): string => JSON.stringify(value);

describe('the accepted event set is the contract’s event set', () => {
  it('lists the same five variants as SseEventSchema', () => {
    const contractTypes = SseEventSchema.options.map((option) => option.shape.type.value).sort();
    expect([...FEED_EVENT_TYPES].sort()).toEqual(contractTypes);
  });

  it('parses every fixture frame in contract/mock/fixtures.ts', () => {
    expect(SSE_FIXTURE).toHaveLength(5);
    for (const event of SSE_FIXTURE) {
      const parsed = parseSseEvent(frame(event));
      expect(parsed, JSON.stringify(event)).not.toBeNull();
      expect(parsed?.type).toBe(event.type);
      // The parsed frame is itself contract-valid, field for field.
      expect(SseEventSchema.safeParse(parsed).success).toBe(true);
    }
  });
});

describe('fail closed', () => {
  const bad = [
    'not json',
    '{}',
    frame({ type: 'stage.updated' }),
    frame({
      type: 'stage.updated',
      video_id: 'v',
      stage: 'ZZ',
      state: 'done',
      stale: false,
      occurred_at: '2026-10-20T09:41:12.000Z',
    }),
    frame({
      type: 'stage.updated',
      video_id: 'v',
      stage: 'IM',
      state: 'exploded',
      stale: false,
      occurred_at: '2026-10-20T09:41:12.000Z',
    }),
    frame({
      type: 'video.updated',
      video_id: 'v',
      status: 'PAUSED',
      current_stage: 'IM',
      attention_kind: 'none',
      attention_reason: null,
      occurred_at: '2026-10-20T09:41:12.000Z',
    }),
    frame({
      type: 'batch.progress',
      batch_id: 'b',
      completed_count: -1,
      target_count: 8,
      status: 'ACTIVE',
      occurred_at: '2026-10-20T09:41:12.000Z',
    }),
    frame({
      type: 'health.changed',
      ready: 'yes',
      degraded_reasons: [],
      occurred_at: '2026-10-20T09:41:12.000Z',
    }),
    frame({ type: 'stage.updated', stage: 'IM', occurred_at: 'yesterday' }),
    frame({ type: 'unknown.event', occurred_at: '2026-10-20T09:41:12.000Z' }),
  ];

  it.each(bad)('drops %s', (payload) => {
    expect(parseSseEvent(payload)).toBeNull();
  });
});

describe('the reducer', () => {
  const base = (): FeedState => ({
    ...emptyFeedState(),
    stages: { IM: { state: 'running', stale: false }, NA: { state: 'done', stale: false } },
    video: {
      status: 'RUNNING',
      currentStage: 'IM',
      attentionKind: 'none',
      attentionReason: null,
    },
  });

  it('applies a stage update without touching the other stages', () => {
    const event = parseSseEvent(
      frame({
        type: 'stage.updated',
        video_id: 'v',
        stage: 'IM',
        state: 'done',
        stale: false,
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    if (event === null) throw new Error('frame rejected');
    const next = applyFeedEvent(base(), event);
    expect(next.stages['IM']).toEqual({ state: 'done', stale: false });
    expect(next.stages['NA']).toEqual({ state: 'done', stale: false });
    expect(next.lastEventAt).toBe('2026-10-20T09:41:12.000Z');
  });

  it('records staleness independently of the stored state (DI-05)', () => {
    const event = parseSseEvent(
      frame({
        type: 'stage.updated',
        video_id: 'v',
        stage: 'NA',
        state: 'done',
        stale: true,
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    if (event === null) throw new Error('frame rejected');
    const next = applyFeedEvent(base(), event);
    expect(next.stages['NA']).toEqual({ state: 'done', stale: true });
    expect(staleCodes(next.stages)).toEqual(['NA']);
  });

  it('keeps batch progress per batch and health readiness last-wins', () => {
    const progress = parseSseEvent(
      frame({
        type: 'batch.progress',
        batch_id: 'b1',
        completed_count: 5,
        target_count: 8,
        status: 'ACTIVE',
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    const health = parseSseEvent(
      frame({
        type: 'health.changed',
        ready: false,
        degraded_reasons: ['disk headroom below 20 %'],
        occurred_at: '2026-10-20T09:41:13.000Z',
      }),
    );
    if (progress === null || health === null) throw new Error('frame rejected');
    const afterProgress = applyFeedEvent(base(), progress);
    const afterHealth = applyFeedEvent(afterProgress, health);
    expect(afterHealth.batches['b1']).toEqual({ completed: 5, total: 8, status: 'ACTIVE' });
    expect(afterHealth.ready).toBe(false);
  });

  it('groups stale codes into the ribbon only when three or more are consecutive', () => {
    expect(
      ribbonCodes({ NA: { state: 'stale', stale: true }, TC: { state: 'stale', stale: true } }),
    ).toEqual([]);
    expect(
      ribbonCodes({
        NA: { state: 'stale', stale: true },
        TC: { state: 'stale', stale: true },
        RE: { state: 'stale', stale: true },
      }),
    ).toEqual(['NA', 'TC', 'RE']);
    expect(
      ribbonCodes({
        NA: { state: 'stale', stale: true },
        TC: { state: 'stale', stale: true },
        QC: { state: 'stale', stale: true },
      }),
    ).toEqual([]);
  });
});

describe('announcements and the chip', () => {
  it('names the stage and its new state in one sentence', () => {
    const event = parseSseEvent(
      frame({
        type: 'stage.updated',
        video_id: 'v',
        stage: 'IM',
        state: 'done',
        stale: false,
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    expect(event === null ? null : eventAnnouncement(event)).toBe('Images: done.');
  });

  it('announces attention with the reason, and stays quiet for a benign update', () => {
    const attention = parseSseEvent(
      frame({
        type: 'video.updated',
        video_id: 'v',
        status: 'NEEDS_ATTENTION',
        current_stage: 'FA',
        attention_kind: 'approval',
        attention_reason: 'final approval',
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    const quiet = parseSseEvent(
      frame({
        type: 'video.updated',
        video_id: 'v',
        status: 'RUNNING',
        current_stage: 'IM',
        attention_kind: 'none',
        attention_reason: null,
        occurred_at: '2026-10-20T09:41:12.000Z',
      }),
    );
    expect(attention === null ? null : eventAnnouncement(attention)).toBe(
      'Needs attention: final approval.',
    );
    expect(quiet === null ? null : eventAnnouncement(quiet)).toBeNull();
  });

  it('resolves the chip from the attention kind, because the event carries no stage state', () => {
    expect(chipStateForEvent('NEEDS_ATTENTION', 'failed', null)).toBe('failed');
    expect(chipStateForEvent('NEEDS_ATTENTION', 'approval', null)).toBe('awaiting_approval');
    expect(chipStateForEvent('NEEDS_ATTENTION', 'blocked', null)).toBe('blocked');
    expect(chipStateForEvent('RUNNING', 'none', null)).toBe('running');
    expect(chipStateForEvent('COMPLETE', 'none', null)).toBe('done');
  });
});
