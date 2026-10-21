import { describe, expect, it } from 'vitest';

import { LoginBackoff } from './backoff.js';

function clock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * TECH_DESIGN §10: "a small login backoff (exponential) mitigates LAN brute
 * force without a reset surface". The schedule is pinned here so a change is a
 * deliberate test change: 1 s, 4 s, 16 s, 64 s, 256 s, capped at 300 s.
 */
describe('login backoff (R-015, TECH_DESIGN §10)', () => {
  it('allows the first attempt and blocks for 1 s after the first failure', () => {
    const c = clock();
    const backoff = new LoginBackoff({ now: c.now });
    expect(backoff.check('k')).toEqual({ allowed: true, retryAfterS: 0 });
    expect(backoff.recordFailure('k')).toEqual({ allowed: false, retryAfterS: 1 });
    expect(backoff.check('k')).toEqual({ allowed: false, retryAfterS: 1 });
    c.advance(500);
    expect(backoff.check('k')).toEqual({ allowed: false, retryAfterS: 1 });
    c.advance(500);
    expect(backoff.check('k')).toEqual({ allowed: true, retryAfterS: 0 });
  });

  it('doubles the delay on the pinned exponential schedule and caps it at 300 s', () => {
    const c = clock();
    const backoff = new LoginBackoff({ now: c.now });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const decision = backoff.recordFailure('k');
      delays.push(decision.retryAfterS);
      c.advance(decision.retryAfterS * 1000);
    }
    expect(delays).toEqual([1, 4, 16, 64, 256, 300, 300, 300]);
  });

  it('resets on success', () => {
    const c = clock();
    const backoff = new LoginBackoff({ now: c.now });
    backoff.recordFailure('k');
    backoff.recordFailure('k');
    backoff.recordSuccess('k');
    expect(backoff.check('k')).toEqual({ allowed: true, retryAfterS: 0 });
    expect(backoff.recordFailure('k').retryAfterS).toBe(1);
  });

  it('keeps keys independent and prunes stale entries', () => {
    const c = clock();
    const backoff = new LoginBackoff({ now: c.now, windowSeconds: 60 });
    backoff.recordFailure('a');
    expect(backoff.check('b')).toEqual({ allowed: true, retryAfterS: 0 });
    expect(backoff.size).toBe(1);
    c.advance(61_000);
    expect(backoff.prune()).toBe(1);
    expect(backoff.size).toBe(0);
  });
});
