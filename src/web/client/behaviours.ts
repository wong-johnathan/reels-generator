/**
 * Shell behaviours as pure functions over an injected clock, an injected text
 * target and injected element shapes (UI_SPEC §8.5, UX §7).
 *
 * The DOM binding lives in shell.ts; keeping the rules here means the
 * announcement budget, the freshness label and the focus trap maths are
 * testable in Node with no browser and no timers.
 */

/**
 * Wording helpers live in ../format.ts (shared with the server renderer); they
 * are re-exported here so surfaces import one client-facing module.
 */
export {
  describeFreshness,
  gateAnnouncement,
  progressAnnouncement,
  type Freshness,
} from '../format.js';

export interface TextTarget {
  textContent: string;
}

export interface AnnouncerOptions {
  /** AX-10: at most one polite announcement per 5 s. */
  readonly debounceMs?: number;
  /** §8.5: empty the region after 10 s so a repeated message is re-announced. */
  readonly clearAfterMs?: number;
}

export interface AnnounceOptions {
  /** Assertive region: degraded transition or session expiry only. */
  readonly urgent?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_CLEAR_MS = 10_000;

/**
 * One live region. Polite messages are coalesced to one per `debounceMs`
 * (newest wording wins); urgent messages bypass the budget; both clear after
 * `clearAfterMs` so identical repeats are announced again.
 */
export class LiveRegion {
  private readonly target: TextTarget;
  private readonly debounceMs: number;
  private readonly clearAfterMs: number;
  private lastEmittedAt = Number.NEGATIVE_INFINITY;
  private lastWritten = '';
  private pending: string | null = null;

  constructor(target: TextTarget, options: AnnouncerOptions = {}) {
    this.target = target;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.clearAfterMs = options.clearAfterMs ?? DEFAULT_CLEAR_MS;
  }

  announce(message: string, now: number, options: AnnounceOptions = {}): void {
    const text = message.trim();
    if (text.length === 0) return;

    const urgent = options.urgent === true;
    if (!urgent && now - this.lastEmittedAt < this.debounceMs) {
      this.pending = text;
      return;
    }
    this.emit(text, now);
  }

  /** Call on a short interval: flushes a due pending message and clears old text. */
  poll(now: number): void {
    if (this.pending !== null && now - this.lastEmittedAt >= this.debounceMs) {
      const message = this.pending;
      this.pending = null;
      this.emit(message, now);
      return;
    }
    if (this.lastWritten.length > 0 && now - this.lastEmittedAt >= this.clearAfterMs) {
      this.lastWritten = '';
      this.target.textContent = '';
    }
  }

  private emit(message: string, now: number): void {
    this.lastEmittedAt = now;
    this.lastWritten = message;
    this.target.textContent = message;
  }
}

export interface ActiveElementShape {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

const TEXT_FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** AX-03: single-key shortcuts stay inert while a text field has focus. */
export function isTextField(active: ActiveElementShape | null): boolean {
  if (active === null) return false;
  if (active.isContentEditable === true) return true;
  return TEXT_FIELDS.has((active.tagName ?? '').toUpperCase());
}

/**
 * §8.5 rule: nothing is announced while focus is inside a text field unless the
 * announcement is the operator's own action.
 */
export function shouldAnnounce(
  active: ActiveElementShape | null,
  operatorInitiated: boolean,
): boolean {
  return operatorInitiated || !isTextField(active);
}

/** AX-09: wrap focus inside a dialog (shift moves backwards). */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  const delta = shift ? -1 : 1;
  return (current + delta + count) % count;
}

export interface FocusableShape {
  readonly tagName?: string;
  readonly disabled?: boolean;
  readonly hasHref?: boolean;
  readonly tabIndex?: number;
}

const NATIVE_FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Matches the selector below: disabled controls and tabindex="-1" are skipped. */
export function isFocusable(element: FocusableShape): boolean {
  const tag = (element.tagName ?? '').toUpperCase();
  if (element.disabled === true) return false;
  if (typeof element.tabIndex === 'number' && element.tabIndex < 0) return false;
  if (tag === 'A') return element.hasHref === true;
  if (NATIVE_FOCUSABLE.has(tag)) return true;
  return typeof element.tabIndex === 'number' && element.tabIndex >= 0;
}

/** The DOM equivalent of `isFocusable`, used by shell.ts and later dialogs. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');
