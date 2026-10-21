/**
 * S-10 script review view model (UI_SPEC §6.6 W-05, §5 UC-06, §9.4
 * C-09/C-10/C-11, R-003-2, R-005-2, R-027-3).
 *
 * Everything here is a pure derivation from the frozen contract's
 * `ScriptViewSchema`. Nothing is computed that the server already decided:
 * `budget.within_band` is read, not recomputed, and the claim gate is a
 * function of the persisted claim statuses only. Where the contract has no
 * field (the number of stored references, the approving operator), the gap is
 * named in `evidence/t_8e44bd1a.md` rather than invented here.
 */
import type { z } from 'zod';

import type { ClaimViewSchema, ScriptViewSchema } from '../../../contract/api.js';
import type { ClaimStatus } from '../../shared/states.js';
import { isoSeconds } from '../format.js';
import { STAGE_LABELS } from '../../shared/stages.js';

export type ScriptView = z.infer<typeof ScriptViewSchema>;
export type ClaimView = z.infer<typeof ClaimViewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Word budget (C-11, W-05 budget bar)
// ─────────────────────────────────────────────────────────────────────────────

export const WORD_BUDGET_WARNING =
  'Outside the band, narration will most likely miss the ±5% duration check and return here after one TTS call.';

export interface WordBudgetView {
  /** `228 words → 75.1 s @ 3.035 w/s` */
  readonly wordsLine: string;
  /** `band 216–239 words (71.2–78.7 s)` */
  readonly bandLine: string;
  readonly withinBand: boolean;
  /** C-11's second sentence, present only when the count is out of band. */
  readonly warning: string | null;
  /** Words per second, as displayed (three decimals, truncated — never rounded up). */
  readonly rate: number;
}

/**
 * W-05 prints three decimals; C-11 calls it "the measured 3.035 words/s", which
 * is 228 / 75.1 truncated rather than rounded (3.036). Truncating keeps the
 * printed rate from ever claiming a faster narration than the estimate.
 */
function displayRate(wordCount: number, estimatedRuntimeS: number): number {
  if (wordCount <= 0 || estimatedRuntimeS <= 0) return 0;
  return Math.floor((wordCount / estimatedRuntimeS) * 1000) / 1000;
}

function seconds(value: number): string {
  return value.toFixed(1);
}

export function wordBudgetView(script: ScriptView): WordBudgetView {
  const rate = displayRate(script.word_count, script.estimated_runtime_s);
  const minWords = script.budget.min_words;
  const maxWords = script.budget.max_words;

  const wordsLine =
    rate === 0
      ? script.word_count + ' words → — s @ — w/s'
      : script.word_count +
        ' words → ' +
        seconds(script.estimated_runtime_s) +
        ' s @ ' +
        rate.toFixed(3) +
        ' w/s';

  const bandLine =
    rate === 0
      ? 'band ' + minWords + '–' + maxWords + ' words'
      : 'band ' +
        minWords +
        '–' +
        maxWords +
        ' words (' +
        seconds(minWords / rate) +
        '–' +
        seconds(maxWords / rate) +
        ' s)';

  return {
    wordsLine,
    bandLine,
    withinBand: script.budget.within_band,
    warning: script.budget.within_band ? null : WORD_BUDGET_WARNING,
    rate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8-gram scan (R-003-2)
// ─────────────────────────────────────────────────────────────────────────────

export interface EightGramView {
  readonly pass: boolean;
  readonly label: '8-gram';
  readonly word: 'PASS' | 'FAIL';
  /** Operator-visible only (R-003-3): the sentence names a reference label, never its text. */
  readonly text: string;
  readonly chipState: 'done' | 'failed';
}

/**
 * `violations` carries reference labels. Anything after the first colon is
 * dropped so a reference body can never reach the operator surface (R-003-3).
 */
function referenceLabels(violations: readonly string[]): string[] {
  const labels: string[] = [];
  for (const violation of violations) {
    const label = (violation.split(':')[0] ?? '').trim();
    if (label.length > 0) labels.push(label);
  }
  return labels;
}

export function eightGramView(script: ScriptView): EightGramView {
  if (script.eight_gram.pass) {
    return {
      pass: true,
      label: '8-gram',
      word: 'PASS',
      text: '8-gram scan: PASS — no run of 8 or more words matches a stored reference.',
      chipState: 'done',
    };
  }
  const labels = referenceLabels(script.eight_gram.violations);
  const which = labels.length === 0 ? 'a stored reference' : labels.join(', ');
  return {
    pass: false,
    label: '8-gram',
    word: 'FAIL',
    text:
      '8-gram scan: FAIL — a run of 8 or more words matches ' + which + '. Reword before approval.',
    chipState: 'failed',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claims (IP-10, R-027-2, C-10)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimRow {
  readonly id: string;
  readonly text: string;
  readonly factual: boolean;
  readonly status: ClaimStatus;
  /** `example.org ok` / `404 !` / `-- !` / `acknowledged` / `non-factual`. */
  readonly sourceLabel: string;
  readonly unresolved: boolean;
}

export interface ClaimsView {
  /** `CLAIMS (14 factual · 11 sourced · 3 unsourced)` */
  readonly summary: string;
  readonly rows: readonly ClaimRow[];
  readonly factual: number;
  readonly sourced: number;
  readonly unresolved: number;
  readonly acknowledged: number;
}

/** R-027-2: an unreachable URL does not count as sourced. */
function isUnresolvedClaim(claim: ClaimView): boolean {
  if (!claim.is_factual) return false;
  return claim.status === 'unsourced' || claim.status === 'url_unreachable';
}

function sourceLabel(claim: ClaimView): string {
  switch (claim.status) {
    case 'non_factual':
      return 'non-factual';
    case 'acknowledged_unsourced':
      return 'acknowledged';
    case 'sourced':
      return claim.source === null ? 'source missing !' : claim.source.domain + ' ok';
    case 'url_unreachable':
      return (claim.url_status === null ? '—' : String(claim.url_status)) + ' !';
    case 'unsourced':
      return '-- !';
  }
}

export function claimsView(script: ScriptView): ClaimsView {
  const rows = script.claims.map((claim) => ({
    id: claim.id,
    text: claim.text,
    factual: claim.is_factual,
    status: claim.status,
    sourceLabel: sourceLabel(claim),
    unresolved: isUnresolvedClaim(claim),
  }));
  const factual = rows.filter((row) => row.factual).length;
  const sourced = rows.filter((row) => row.factual && row.status === 'sourced').length;
  const unresolved = rows.filter((row) => row.unresolved).length;
  const acknowledged = rows.filter((row) => row.status === 'acknowledged_unsourced').length;
  return {
    summary:
      'CLAIMS (' + factual + ' factual · ' + sourced + ' sourced · ' + unresolved + ' unsourced)',
    rows,
    factual,
    sourced,
    unresolved,
    acknowledged,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The approval gate (R-005-2, C-09, C-10)
// ─────────────────────────────────────────────────────────────────────────────

export const APPROVE_REASON_ID = 'script-approve-reason';
export const APPROVE_LABEL = 'Approve script';

export interface ApprovalView {
  readonly approved: boolean;
  /** `Approved rev 4 · operator · 2026-10-20T15:41:00Z` */
  readonly record: string | null;
  readonly approvedAt: string | null;
  readonly blocked: boolean;
  /** Every visible reason the gate is closed, exact copy (C-10, 8-gram). */
  readonly reasons: readonly string[];
  /** C-09: what approval unlocks, stated before the operator commits. */
  readonly unlockLine: string;
  /** R-027-3/OQ-1: acknowledged claims are allowed and recorded. */
  readonly note: string | null;
  readonly label: string;
  readonly canApprove: boolean;
  readonly describedBy: string | null;
}

export function approvalView(
  script: ScriptView,
  detail: { readonly scene_count: number },
): ApprovalView {
  const claims = claimsView(script);
  const eightGram = eightGramView(script);
  const approved = script.status === 'approved' && script.approved_at !== null;
  const reasons: string[] = [];

  // An approved script has already passed the gate; the record line replaces the
  // control, so re-stating a citation block would describe a state the operator
  // is no longer in.
  if (!approved && !eightGram.pass) reasons.push(eightGram.text);

  if (!approved && claims.unresolved > 0) {
    const n = claims.unresolved;
    const total = claims.factual;
    reasons.push(
      'Script approval is blocked: ' +
        n +
        ' of ' +
        total +
        ' factual claims ' +
        (n === 1 ? 'has' : 'have') +
        ' no resolvable source. Source, reword or acknowledge ' +
        (n === 1 ? 'it' : 'all ' + n) +
        ' first.',
    );
  }

  const sceneCount = detail.scene_count;
  const unlockLine =
    'Approving the script unlocks ' +
    sceneCount +
    ' image ' +
    (sceneCount === 1 ? 'call' : 'calls') +
    ' and 1 TTS call for this video. Nothing runs until you approve.';

  let note: string | null = null;
  if (!approved && claims.acknowledged > 0 && claims.unresolved === 0) {
    note =
      'Approval is allowed. ' +
      claims.acknowledged +
      (claims.acknowledged === 1 ? ' claim is' : ' claims are') +
      ' acknowledged as unsourced and ' +
      (claims.acknowledged === 1 ? 'is' : 'are') +
      ' listed in the export source manifest.';
  }

  return {
    approved,
    record:
      approved && script.approved_at !== null
        ? 'Approved rev ' + script.revision + ' · operator · ' + isoSeconds(script.approved_at)
        : null,
    approvedAt: approved ? script.approved_at : null,
    blocked: reasons.length > 0,
    reasons,
    unlockLine,
    note,
    label: APPROVE_LABEL,
    canApprove: !approved && reasons.length === 0,
    describedBy: reasons.length > 0 ? APPROVE_REASON_ID : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptStatusView {
  /** `Script rev 4` / `Script rev 4 (unsaved changes)` */
  readonly line: string;
  readonly revision: number;
  readonly dirty: boolean;
}

export function scriptStatusView(
  script: ScriptView,
  options: { dirty: boolean },
): ScriptStatusView {
  return {
    line: 'Script rev ' + script.revision + (options.dirty ? ' (unsaved changes)' : ''),
    revision: script.revision,
    dirty: options.dirty,
  };
}

/** The stale-ribbon cause line (UC-05 content, IP-01 persistence rule). */
export function staleCauseLine(cause: string | null, revision: number | null): string {
  if (cause === null || cause.trim().length === 0) {
    return 'stale: an edit made this stage out of date';
  }
  return 'stale: ' + cause + (revision === null ? '' : ', rev ' + revision);
}

/** Only used by the renderer to label `[data-stage-code]` cells. */
export function stageLabel(code: keyof typeof STAGE_LABELS): string {
  return STAGE_LABELS[code];
}
