import { describe, expect, it } from 'vitest';

import {
  BATCH_STATES,
  STAGE_STATES,
  VIDEO_STATES,
  type BatchState,
  type StageState,
  type VideoState,
} from '../shared/index.js';
import {
  BATCH_EVENTS,
  BATCH_TRANSITIONS,
  IllegalTransitionError,
  STAGE_EVENTS,
  STAGE_TRANSITIONS,
  VIDEO_EVENTS,
  VIDEO_TRANSITIONS,
  isLegalBatchTransition,
  isLegalStageTransition,
  isLegalVideoTransition,
  transitionBatch,
  transitionStage,
  transitionVideo,
  type BatchEvent,
  type StageEvent,
  type VideoEvent,
} from './state-machine.js';

/**
 * §4.2 legal stage transitions, quoted verbatim from TECH_DESIGN. The table is
 * the spec-lock: if the module's STAGE_TRANSITIONS ever disagrees with this
 * list, the test fails even though the module is internally consistent.
 */
const LEGAL_STAGE_TRANSITIONS: ReadonlyArray<readonly [StageState, StageEvent, StageState]> = [
  ['not_run', 'claim', 'running'],
  ['not_run', 'block', 'blocked'],
  ['not_run', 'cancel', 'cancelled'],
  ['running', 'succeed', 'done'],
  ['running', 'fail', 'failed'],
  ['running', 'gate', 'awaiting_approval'],
  ['running', 'cancel', 'cancelled'],
  ['done', 'invalidate', 'stale'],
  // D-J: a finished stage can be *held* for approval. The storyboard completes
  // its work, then parks so no image is paid for before the operator reads it.
  ['done', 'gate', 'awaiting_approval'],
  ['done', 'cancel', 'cancelled'],
  ['awaiting_approval', 'approve', 'done'],
  ['awaiting_approval', 'reject_no_edit', 'awaiting_approval'],
  ['awaiting_approval', 'invalidate', 'stale'],
  ['awaiting_approval', 'cancel', 'cancelled'],
  ['stale', 'regenerate', 'running'],
  ['stale', 'accept_staleness', 'done'],
  ['stale', 'cancel', 'cancelled'],
  ['failed', 'retry', 'running'],
  ['failed', 'cancel', 'cancelled'],
  ['blocked', 'unblock', 'not_run'],
  ['blocked', 'cancel', 'cancelled'],
];

/** §4.5 video-level transitions. */
const LEGAL_VIDEO_TRANSITIONS: ReadonlyArray<readonly [VideoState, VideoEvent, VideoState]> = [
  ['NOT_STARTED', 'first_claim', 'RUNNING'],
  ['NOT_STARTED', 'cancel', 'CANCELLED'],
  ['RUNNING', 'needs_attention', 'NEEDS_ATTENTION'],
  ['RUNNING', 'final_approve', 'COMPLETE'],
  ['RUNNING', 'cancel', 'CANCELLED'],
  ['NEEDS_ATTENTION', 'resume', 'RUNNING'],
  ['NEEDS_ATTENTION', 'final_approve', 'COMPLETE'],
  ['NEEDS_ATTENTION', 'cancel', 'CANCELLED'],
  ['COMPLETE', 'reopen', 'NEEDS_ATTENTION'],
  ['COMPLETE', 'cancel', 'CANCELLED'],
];

/** §4.6 batch transitions (COMPLETE → CANCELLED is intentionally absent). */
const LEGAL_BATCH_TRANSITIONS: ReadonlyArray<readonly [BatchState, BatchEvent, BatchState]> = [
  ['ACTIVE', 'all_complete', 'COMPLETE'],
  ['ACTIVE', 'cancel', 'CANCELLED'],
  ['COMPLETE', 'reopen', 'ACTIVE'],
];

describe('stage state machine (§4.2)', () => {
  it('encodes the TECH_DESIGN §4.2 transitions plus the approval hold (D-J)', () => {
    const fromTable = Object.entries(STAGE_TRANSITIONS).flatMap(([from, byEvent]) =>
      Object.entries(byEvent).map(([event, to]) => [from, event, to] as const),
    );
    expect(fromTable).toHaveLength(LEGAL_STAGE_TRANSITIONS.length);
    for (const [from, event, to] of LEGAL_STAGE_TRANSITIONS) {
      expect(STAGE_TRANSITIONS[from][event]).toBe(to);
    }
  });

  it('fires every legal transition (100% coverage)', () => {
    for (const [from, event, to] of LEGAL_STAGE_TRANSITIONS) {
      expect(transitionStage(from, event)).toBe(to);
      expect(isLegalStageTransition(from, to)).toBe(true);
    }
  });

  it('rejects every illegal (from, to) pair', () => {
    const legal: ReadonlySet<string> = new Set(
      LEGAL_STAGE_TRANSITIONS.map(([f, , t]) => `${f}->${t}`),
    );
    for (const from of STAGE_STATES) {
      for (const to of STAGE_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(isLegalStageTransition(from, to)).toBe(false);
      }
    }
  });

  it('rejects every illegal (from, event) combination with a typed error', () => {
    const legal: ReadonlySet<string> = new Set(
      LEGAL_STAGE_TRANSITIONS.map(([f, e]) => `${f}+${e}`),
    );
    for (const from of STAGE_STATES) {
      for (const event of STAGE_EVENTS) {
        if (legal.has(`${from}+${event}`)) continue;
        expect(() => transitionStage(from, event)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('treats cancelled as terminal — no outgoing stage transition', () => {
    for (const event of STAGE_EVENTS) {
      expect(() => transitionStage('cancelled', event)).toThrow(IllegalTransitionError);
    }
  });
});

describe('video state machine (§4.5)', () => {
  it('fires every legal video transition', () => {
    for (const [from, event, to] of LEGAL_VIDEO_TRANSITIONS) {
      expect(transitionVideo(from, event)).toBe(to);
      expect(isLegalVideoTransition(from, to)).toBe(true);
    }
  });

  it('rejects every illegal video transition', () => {
    const legal: ReadonlySet<string> = new Set(
      LEGAL_VIDEO_TRANSITIONS.map(([f, , t]) => `${f}->${t}`),
    );
    for (const from of VIDEO_STATES) {
      for (const to of VIDEO_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(isLegalVideoTransition(from, to)).toBe(false);
      }
      for (const event of VIDEO_EVENTS) {
        const hasLegal = LEGAL_VIDEO_TRANSITIONS.some(([f, e]) => f === from && e === event);
        if (hasLegal) continue;
        expect(() => transitionVideo(from, event)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('treats CANCELLED as terminal', () => {
    for (const event of VIDEO_EVENTS) {
      expect(() => transitionVideo('CANCELLED', event)).toThrow(IllegalTransitionError);
    }
  });
});

describe('batch state machine (§4.6)', () => {
  it('fires every legal batch transition', () => {
    for (const [from, event, to] of LEGAL_BATCH_TRANSITIONS) {
      expect(transitionBatch(from, event)).toBe(to);
      expect(isLegalBatchTransition(from, to)).toBe(true);
    }
  });

  it('rejects every illegal batch transition', () => {
    const legal: ReadonlySet<string> = new Set(
      LEGAL_BATCH_TRANSITIONS.map(([f, , t]) => `${f}->${t}`),
    );
    for (const from of BATCH_STATES) {
      for (const to of BATCH_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(isLegalBatchTransition(from, to)).toBe(false);
      }
      for (const event of BATCH_EVENTS) {
        const hasLegal = LEGAL_BATCH_TRANSITIONS.some(([f, e]) => f === from && e === event);
        if (hasLegal) continue;
        expect(() => transitionBatch(from, event)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('treats CANCELLED as terminal', () => {
    for (const event of BATCH_EVENTS) {
      expect(() => transitionBatch('CANCELLED', event)).toThrow(IllegalTransitionError);
    }
  });
});

describe('vocabulary invariants', () => {
  it('event sets are non-empty and the transition tables cover every state', () => {
    expect(STAGE_EVENTS.length).toBeGreaterThan(0);
    expect(VIDEO_EVENTS.length).toBeGreaterThan(0);
    expect(BATCH_EVENTS.length).toBeGreaterThan(0);
    expect(Object.keys(STAGE_TRANSITIONS)).toHaveLength(STAGE_STATES.length);
    expect(Object.keys(VIDEO_TRANSITIONS)).toHaveLength(VIDEO_STATES.length);
    expect(Object.keys(BATCH_TRANSITIONS)).toHaveLength(BATCH_STATES.length);
  });
});
