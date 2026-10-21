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
