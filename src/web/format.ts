/**
 * Number and freshness wording shared by the server renderer and the client
 * enhancer (UI_SPEC §8.5, §9.1 rule 2, AX-19, AX-27).
 *
 * One implementation on both sides keeps the server-rendered strip and the
 * client-updated strip from drifting into two different sentences.
 */

export interface Freshness {
  readonly text: string;
  readonly stale: boolean;
}

/** AX-27: beyond 20 s the feed is labelled delayed and the count is stale. */
export const FRESHNESS_STALE_AFTER_MS = 20_000;

export function describeFreshness(ageMs: number): Freshness {
  const clamped = Math.max(0, Math.trunc(ageMs));
  const seconds = Math.floor(clamped / 1000);
  const stale = clamped > FRESHNESS_STALE_AFTER_MS;
  const prefix = stale ? 'progress feed delayed — last update ' : 'last update ';
  return { text: prefix + seconds + ' s ago', stale };
}

/** `<number> <noun>` with exact singular/plural, never a vague quantifier. */
export function countPair(count: number, singular: string, plural: string): string {
  return count + ' ' + (count === 1 ? singular : plural);
}

/** AX-08 template: names the video, the gate and how many need attention. */
export function gateAnnouncement(input: {
  readonly position: number;
  readonly total: number;
  readonly gate: string;
  readonly attentionCount: number;
}): string {
  const attention =
    countPair(input.attentionCount, 'video', 'videos') +
    (input.attentionCount === 1 ? ' needs' : ' need') +
    ' attention.';
  return (
    'Video ' +
    input.position +
    ' of ' +
    input.total +
    ' needs ' +
    input.gate +
    ' approval. ' +
    attention
  );
}

/** AX-10 template: one debounced summary, counts only, never per row. */
export function progressAnnouncement(input: {
  readonly complete: number;
  readonly total: number;
  readonly attention: number;
}): string {
  const attention =
    input.attention + (input.attention === 1 ? ' needs attention.' : ' need attention.');
  return input.complete + ' of ' + input.total + ' complete. ' + attention;
}

export interface AgeLabel {
  /** Relative wording for a list cell (§9.6). */
  readonly text: string;
  /** The absolute timestamp as received, for the accessible name. */
  readonly absolute: string;
}

/**
 * §9.6: relative wording in lists, the absolute value in the accessible name.
 * Rounding down keeps "2 h ago" from claiming more time has passed than has.
 */
export function describeAge(now: number, iso: string): AgeLabel {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return { text: '—', absolute: iso };
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  let text: string;
  if (seconds < 60) {
    text = seconds + ' s ago';
  } else if (seconds < 3_600) {
    text = Math.floor(seconds / 60) + ' min ago';
  } else if (seconds < 86_400) {
    text = Math.floor(seconds / 3_600) + ' h ago';
  } else {
    const days = Math.floor(seconds / 86_400);
    text = days + (days === 1 ? ' day ago' : ' days ago');
  }
  return { text, absolute: iso };
}

/** `2026-10-20T14:12:00.000Z` → `2026-10-20T14:12:00Z` for inline copy. */
export function isoSeconds(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * §9.6: plain integers, thousands separators only above 9,999, never `k`,
 * never a rounding. Grouped manually so the output does not depend on the
 * host's locale data.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.trunc(value);
  if (Math.abs(rounded) <= 9_999) return String(rounded);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * §9.6: bytes use binary units with one decimal (`6.2 GB`, `1.8 GB`,
 * `41.2 MB`). Whole bytes carry no decimal. Never `k`, never a currency.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  if (unit === 0) return Math.trunc(value) + ' B';
  return scaled.toFixed(1) + ' ' + BYTE_UNITS[unit];
}
