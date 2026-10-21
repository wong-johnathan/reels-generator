/**
 * Login backoff — TECH_DESIGN §10 ("a small login backoff (exponential)
 * mitigates LAN brute force without a reset surface").
 *
 * Delays are per attempt key (client address + username), doubling from 1 s and
 * capped at 5 minutes. State is in memory by design: the deployment is a single
 * `web` container (D3), and a restart clearing a 5-minute throttle is an
 * acceptable trade for not adding a table outside the design's 22.
 */
export interface BackoffDecision {
  readonly allowed: boolean;
  /** Whole seconds until the next attempt is allowed (0 when allowed). */
  readonly retryAfterS: number;
}

export interface LoginBackoffOptions {
  readonly delaysSeconds?: readonly number[];
  readonly maxDelaySeconds?: number;
  /** Entries older than this are pruned (they would have decayed anyway). */
  readonly windowSeconds?: number;
  readonly now?: () => Date;
}

interface Entry {
  failures: number;
  blockedUntilMs: number;
  lastFailureMs: number;
}

const DEFAULT_DELAYS = [1, 4, 16, 64, 256, 1024] as const;
const DEFAULT_MAX_DELAY_SECONDS = 300;
const DEFAULT_WINDOW_SECONDS = 3600;

export class LoginBackoff {
  private readonly entries = new Map<string, Entry>();
  private readonly delays: readonly number[];
  private readonly maxDelaySeconds: number;
  private readonly windowSeconds: number;
  private readonly now: () => Date;

  constructor(options: LoginBackoffOptions = {}) {
    this.delays = options.delaysSeconds ?? DEFAULT_DELAYS;
    this.maxDelaySeconds = options.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS;
    this.windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  get size(): number {
    return this.entries.size;
  }

  check(key: string): BackoffDecision {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterS: 0 };
    const remainingMs = entry.blockedUntilMs - this.now().getTime();
    if (remainingMs <= 0) return { allowed: true, retryAfterS: 0 };
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  recordFailure(key: string): BackoffDecision {
    const nowMs = this.now().getTime();
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const index = Math.min(failures - 1, this.delays.length - 1);
    const delay = Math.min(this.delays[index] ?? this.maxDelaySeconds, this.maxDelaySeconds);
    this.entries.set(key, {
      failures,
      blockedUntilMs: nowMs + delay * 1000,
      lastFailureMs: nowMs,
    });
    return { allowed: false, retryAfterS: delay };
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries whose last failure is outside the window; returns the count. */
  prune(): number {
    const cutoff = this.now().getTime() - this.windowSeconds * 1000;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.lastFailureMs < cutoff) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
