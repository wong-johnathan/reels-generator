import { describe, expect, it } from 'vitest';

import { TokenBucketRateLimiter, UNLIMITED_RATE_LIMITER } from './rate-limit.js';

/** A clock the test owns, so a 10 req/min limit is asserted without sleeping. */
function fakeClock(): {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
  readonly advance: (ms: number) => void;
} {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * B-04 / R-008-2 / TECH_DESIGN §5.7: the bucket is enforced inside the adapter,
 * default 10 requests/min, configurable, and it queues rather than dropping.
 */
describe('TokenBucketRateLimiter (R-008-2)', () => {
  it('rejects a limit that is not a positive integer', () => {
    expect(() => new TokenBucketRateLimiter({ perMinute: 0 })).toThrow(/perMinute/);
    expect(() => new TokenBucketRateLimiter({ perMinute: 1.5 })).toThrow(/perMinute/);
  });

  it('admits perMinute requests immediately and makes the next one wait one refill', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({
      perMinute: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    for (let call = 0; call < 10; call += 1) await limiter.acquire();
    expect(clock.sleeps).toEqual([]);

    await limiter.acquire();
    // 10/min => one token every 6 000 ms.
    expect(clock.sleeps).toEqual([6000]);
  });

  it('serialises concurrent acquirers instead of handing the same token to two callers', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({
      perMinute: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    await Promise.all(Array.from({ length: 12 }, () => limiter.acquire()));

    // Two requests over budget => at least two refill waits, never a negative balance.
    expect(clock.sleeps.length).toBe(2);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(12_000);
  });

  it('refills from measured elapsed time rather than call count', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({
      perMinute: 60,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    clock.advance(1000); // one second of silence => one token back at 60/min
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('exposes an unlimited limiter for the deterministic fakes', async () => {
    await Promise.all(Array.from({ length: 1000 }, () => UNLIMITED_RATE_LIMITER.acquire()));
  });
});
