/**
 * Per-provider-key rate limiting — R-008-2, TECH_DESIGN §5.7.
 *
 * "Per-provider-key token bucket, default 10 requests/min, configurable,
 * enforced inside each adapter". The bucket queues a call until a token is
 * available; it never drops the request.
 *
 * The Redis mirror described in §5.7 (so a worker restart does not reset the
 * window) belongs to the worker/queue layer (B-08); this module is the
 * in-process enforcement every adapter shares. The clock and sleep function
 * are injectable so tests assert the limit without actually waiting.
 */

export interface RateLimiter {
  /** Resolve when the caller may issue one request. */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  /** Burst size and refill budget, in requests per minute. */
  readonly perMinute: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open for a rate-limit wait.
    timer.unref?.();
  });

export class TokenBucketRateLimiter implements RateLimiter {
  readonly perMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ratePerMs: number;
  private tokens: number;
  private lastRefillAt: number;
  /** Serialises acquirers so two concurrent calls cannot spend the same token. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    if (!Number.isInteger(options.perMinute) || options.perMinute < 1) {
      throw new Error(
        `perMinute must be a positive integer (R-008-2), received ${String(options.perMinute)}`,
      );
    }
    this.perMinute = options.perMinute;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.ratePerMs = options.perMinute / 60_000;
    this.tokens = options.perMinute;
    this.lastRefillAt = this.now();
  }

  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.take());
    // Keep the chain alive even if a caller's `take()` rejects.
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private refill(atMs: number): void {
    const elapsed = atMs - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perMinute, this.tokens + elapsed * this.ratePerMs);
    this.lastRefillAt = atMs;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill(this.now());
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs);
      await this.sleep(waitMs);
    }
  }
}

/** For the deterministic fakes: a fake must never make a test wait. */
export const UNLIMITED_RATE_LIMITER: RateLimiter = { acquire: async () => undefined };
