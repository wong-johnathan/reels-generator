/**
 * Per-provider-key rate limit — R-008-2 / TECH_DESIGN §5.7.
 *
 * A token bucket sized to `PROVIDER_RATE_LIMIT_PER_MIN` (default 10/min, below
 * every documented provider QPS: DeepSeek search/fetch is 5 QPS per account and
 * API). Exceeding the bucket *waits*; it never drops a job (TECH_DESIGN §5.7).
 *
 * The clock and sleep are injectable so the pacing is testable without real
 * time passing. Every acquisition is serialised through a promise chain: two
 * concurrent callers must not be handed the same token.
 */

export interface RateLimiter {
  /** Resolve when the caller may issue one request. */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  /** Requests per minute; also the burst capacity. */
  readonly perMinute: number;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to a real `setTimeout` sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucket implements RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefillAt: number;
  /** Serialises acquisitions so concurrent callers cannot share a token. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    const { perMinute } = options;
    if (!Number.isInteger(perMinute) || perMinute <= 0) {
      throw new Error(
        `rate limit requires a positive integer per-minute rate (received ${String(perMinute)})`,
      );
    }
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = perMinute;
    this.lastRefillAt = this.now();
  }

  acquire(): Promise<void> {
    const next = this.tail.then(() => this.take());
    // A failed acquisition must not poison the chain for later callers.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = nowMs;
  }

  private async take(): Promise<void> {
    this.refill(this.now());
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await this.sleep(waitMs);
    this.refill(this.now());
    // Guard against an injected clock that did not advance during the sleep.
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
