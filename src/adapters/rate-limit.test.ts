import { describe, expect, it } from 'vitest';

import { TokenBucket } from './rate-limit.js';

function fakeClock(startMs = 0) {
  const clock = { t: startMs };
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  };
}

describe('per-provider-key rate limit (R-008-2)', () => {
  it('allows a full burst of perMinute requests and then paces one per interval', async () => {
    const { sleeps, now, sleep, clock } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 10, now, sleep });

    for (let i = 0; i < 10; i += 1) await bucket.acquire();
    expect(sleeps).toEqual([]);

    await bucket.acquire();
    expect(sleeps).toEqual([6_000]);
    await bucket.acquire();
    expect(sleeps).toEqual([6_000, 6_000]);
    expect(clock.t).toBe(12_000);
  });

  it('refills from elapsed wall-clock time without sleeping', async () => {
    const { sleeps, now, sleep, clock } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 10, now, sleep });
    for (let i = 0; i < 10; i += 1) await bucket.acquire();

    // 30 s at 10/min refills 5 tokens (and no more: the bucket is capped at 10).
    clock.t += 30_000;
    for (let i = 0; i < 5; i += 1) await bucket.acquire();
    expect(sleeps).toEqual([]);

    await bucket.acquire();
    expect(sleeps).toEqual([6_000]);
  });

  it('serialises concurrent acquires so two callers cannot take the same token', async () => {
    const { sleeps, now, sleep, clock } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 10, now, sleep });

    await Promise.all(Array.from({ length: 12 }, () => bucket.acquire()));
    expect(sleeps).toHaveLength(2);
    expect(clock.t).toBe(12_000);
  });

  it('never waits longer than one interval per missing token', async () => {
    const { sleeps, now, sleep } = fakeClock();
    const bucket = new TokenBucket({ perMinute: 600, now, sleep });
    await Promise.all(Array.from({ length: 601 }, () => bucket.acquire()));
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBe(100);
  });

  it('rejects a non-positive or non-integer rate instead of silently disabling the limit', () => {
    for (const perMinute of [0, -1, 1.5, Number.NaN]) {
      expect(() => new TokenBucket({ perMinute }), String(perMinute)).toThrow(
        /positive integer per-minute rate/,
      );
    }
  });
});
