/**
 * Progressive enhancement for the shell (TECH_DESIGN X-2: server-rendered HTML
 * plus enhancement, no SPA framework).
 *
 * The server already renders every state; this module only keeps the freshness
 * label honest (AX-27) and exposes the two live regions to the surfaces that
 * arrive in later cards (§8.5: gate announcements, debounced progress, degraded
 * transitions). It must never re-render content or move focus (AX-06).
 */
import {
  LiveRegion,
  describeFreshness,
  shouldAnnounce,
  type ActiveElementShape,
} from './behaviours.js';

export interface ElementLike {
  textContent: string;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
}

export interface ShellDocumentLike {
  querySelector(selector: string): ElementLike | null;
  readonly activeElement?: ActiveElementShape | null;
}

export interface ShellEnvironment {
  now(): number;
  setInterval?(handler: () => void, ms: number): unknown;
}

export interface ShellEnhancer {
  readonly status: LiveRegion;
  readonly alert: LiveRegion;
  /** Polite announcement; suppressed while focus is in a text field (AX-03). */
  announceStatus(message: string, operatorInitiated?: boolean): void;
  /** Assertive announcement for degraded transitions and session expiry. */
  announceAlert(message: string): void;
  /** Re-render the freshness label and flush/clear the live regions. */
  tick(now: number): void;
}

function updateFreshness(doc: ShellDocumentLike, now: number): void {
  const node = doc.querySelector('[data-updated-at]');
  if (node === null) return;
  const raw = node.getAttribute?.('data-updated-at') ?? '';
  const updatedAt = Number(raw);
  if (raw.length === 0 || !Number.isFinite(updatedAt)) return;
  const described = describeFreshness(now - updatedAt);
  node.textContent = described.text;
  node.setAttribute?.('data-stale', described.stale ? 'true' : 'false');
}

export function initShell(
  doc: ShellDocumentLike,
  env: ShellEnvironment = {
    now: () => Date.now(),
    setInterval: (handler, ms) => setInterval(handler, ms),
  },
): ShellEnhancer | null {
  const statusNode = doc.querySelector('#live-status');
  const alertNode = doc.querySelector('#live-alert');
  if (statusNode === null || alertNode === null) return null;

  const status = new LiveRegion(statusNode);
  const alert = new LiveRegion(alertNode);

  const enhancer: ShellEnhancer = {
    status,
    alert,
    announceStatus(message: string, operatorInitiated = false): void {
      if (!shouldAnnounce(doc.activeElement ?? null, operatorInitiated)) return;
      status.announce(message, env.now());
    },
    announceAlert(message: string): void {
      alert.announce(message, env.now(), { urgent: true });
    },
    tick(now: number): void {
      status.poll(now);
      alert.poll(now);
      updateFreshness(doc, now);
    },
  };

  (globalThis as { reelsAnnounce?: ShellEnhancer }).reelsAnnounce = enhancer;
  env.setInterval?.(() => enhancer.tick(env.now()), 1_000);
  enhancer.tick(env.now());

  return enhancer;
}

// The server renderer is the source of truth; this binding is enhancement only.
const runtimeDocument = (globalThis as { document?: ShellDocumentLike }).document;
if (runtimeDocument !== undefined) {
  initShell(runtimeDocument);
}
