// GENERATED FILE — do not edit by hand.
//
// Source of truth: src/web/styles/tokens.css, base.css, shell.css and auth.css
// (UI_SPEC §2, §4, §6.1, §7). Regenerate with renderEmbeddedModule() in embed.ts;
// tests/web/embedded.test.ts fails the build if this file and the
// stylesheets disagree.
//
// The web image copies only TypeScript output, so the runtime CSS is imported
// from this module instead of being read from disk.
/** tokens.css */
export const tokensCss = String.raw`/*
 * Design tokens — UI_SPEC §2 (colour, type, spacing, radii, motion, focus,
 * elevation, z-index) and §4.1 (shell geometry).
 *
 * Dark is the only theme: there is no prefers-color-scheme switch, and the
 * ratio in each comment is the measured WCAG 2.2 ratio from UI_SPEC §8.2
 * against --surface-panel. tests/web/tokens.test.ts recomputes every pair, so
 * a drifted hex fails the build rather than shipping.
 *
 * No webfont, no icon package, no external reference: the NAS serves no font
 * files (UI_SPEC §2.3, §2.6).
 */

:root {
  color-scheme: dark;

  /* ── surfaces ─────────────────────────────────────────────────────────── */
  --surface-app: #0e1014; /* page background */
  --surface-panel: #15181e; /* default container */
  --surface-raised: #1c2027; /* header bars, dialog, toast */
  --surface-inset: #0a0c10; /* inputs, values, not-started thumbnails */
  --surface-hover: #22272f; /* row/button hover */
  --surface-selected: #263041; /* selected row, current nav item */
  --surface-inverse: #e8ebf0; /* login pressed state only */

  /* state-bearing tints — body text stays >= 12.4:1 on each */
  --surface-stale-tint: #2a2340;
  --surface-danger-tint: #33201f;
  --surface-warning-tint: #302614;
  --surface-success-tint: #13251a;

  /* ── text ─────────────────────────────────────────────────────────────── */
  --text-primary: #e8ebf0; /* 14.88:1 */
  --text-secondary: #aeb7c4; /* 8.78:1 */
  --text-tertiary: #8b95a3; /* 5.86:1 */
  --text-disabled: #5f6875; /* 3.15:1 — WCAG 1.4.3 inactive-control exemption */
  --text-link: #9dbbf9; /* 9.24:1 */
  --text-inverse: #0b0d11; /* 16.27:1 on --surface-inverse */

  /* ── state colours: text >= 4.5:1, boundary >= 3:1 ────────────────────── */
  --accent: #7ea6f8; /* 7.36:1 */
  --success: #4cc26a; /* 7.82:1 */
  --warning: #e3a639; /* 8.28:1 */
  --danger: #ff7b72; /* 7.05:1 */
  --stale: #bba1ff; /* 8.17:1 */
  --running: #4fd1e0; /* 9.76:1 */
  --cancelled: #8b95a3; /* 5.86:1 */

  /* ── borders and fills ────────────────────────────────────────────────── */
  --border-subtle: #272d37; /* 1.28:1 — decorative only */
  --border-default: #6b7480; /* 3.75:1 — every interactive boundary */
  --border-strong: #8b95a3; /* 5.86:1 */
  --accent-fill: #2f5fd0; /* #FFFFFF label 5.72:1 */
  --accent-fill-hover: #3a6ce0; /* #FFFFFF label 4.77:1 */
  --danger-fill: #c62828; /* #FFFFFF label 5.62:1 */
  --danger-fill-hover: #d13a2a; /* #FFFFFF label 4.83:1 */
  --control-fill: #22272f; /* --text-primary label 12.56:1 */

  /* ── type ─────────────────────────────────────────────────────────────── */
  --font-ui:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans',
    sans-serif;
  --font-mono:
    ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  --t-80: 32px; /* login wordmark only */
  --t-70: 24px; /* page title */
  --t-60: 20px; /* section title */
  --t-50: 16px; /* workspace title */
  --t-40: 14px; /* body */
  --t-30: 13px; /* dense body */
  --t-20: 12px; /* metadata */
  --t-10: 11px; /* column headers, chips, eyebrows */
  --lh-80: 40px;
  --lh-70: 32px;
  --lh-60: 28px;
  --lh-50: 24px;
  --lh-40: 22px;
  --lh-30: 20px;
  --lh-20: 18px;
  --lh-10: 16px;
  --fw-regular: 400;
  --fw-semibold: 600;
  --fw-bold: 700;

  /* ── spacing: 4 px base, no arbitrary values ──────────────────────────── */
  --s-0: 0;
  --s-1: 2px;
  --s-2: 4px;
  --s-3: 6px;
  --s-4: 8px;
  --s-5: 12px;
  --s-6: 16px;
  --s-7: 20px;
  --s-8: 24px;
  --s-9: 32px;
  --s-10: 40px;
  --s-11: 48px;
  --s-12: 64px;

  /* ── radii ────────────────────────────────────────────────────────────── */
  --r-1: 2px;
  --r-2: 4px;
  --r-3: 6px;
  --r-4: 10px;
  --r-full: 999px;

  /* ── elevation: shadows only for things that float above the page ─────── */
  --e-1: 0 1px 2px rgba(0, 0, 0, 0.45);
  --e-2: 0 4px 12px rgba(0, 0, 0, 0.5);
  --e-3: 0 12px 32px rgba(0, 0, 0, 0.62);

  /* ── z-index: fixed scale, no invented values ─────────────────────────── */
  --z-content: 0;
  --z-sticky-head: 10;
  --z-banner: 20;
  --z-dropdown: 30;
  --z-dialog: 40;
  --z-toast: 50;

  /* ── motion: only opacity, transform, colour and progress width ───────── */
  --dur-1: 80ms; /* hover, focus */
  --dur-2: 140ms; /* chip swap, selection */
  --dur-3: 220ms; /* panel reveal, banner appear */
  --dur-4: 320ms; /* dialog, toast */
  --spin-duration: 1.2s; /* the only loop in the product */
  --progress-duration: 700ms; /* determinate progress width */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-enter: cubic-bezier(0, 0, 0, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);

  /* ── focus: outline, never box-shadow (survives overflow clipping) ────── */
  --focus-ring-width: 2px;
  --focus-ring-color: #7ea6f8;
  --focus-ring-offset: 2px;
  --focus-ring-style: solid;

  /* ── pointer targets (AX-17) ──────────────────────────────────────────── */
  --target-min: 24px;
  --target-review: 44px;
  --target-gap: 8px;

  /* ── shell geometry (UI_SPEC §4.1, §7.1) ──────────────────────────────── */
  --rail-expanded: 216px;
  --rail-compact: 64px;
  --aside-wide: 360px;
  --aside-compact: 320px;
  --content-max: 1600px;
  --strip-height: 40px;
  --footer-height: 32px;
  --mobile-bar-height: 44px;
}

/* AX-16: reduced motion collapses every duration and stops the one loop. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-1: 0.01ms;
    --dur-2: 0.01ms;
    --dur-3: 0.01ms;
    --dur-4: 0.01ms;
    --spin-duration: 0.01ms;
    --progress-duration: 0.01ms;
  }
}
`;

/** base.css */
export const baseCss = String.raw`/*
 * Base layer — reset, document typography, focus ring, reduced motion and the
 * utilities the shell shares with every later surface (UI_SPEC §2.3, §2.8,
 * §7.3, §8.3; AX-14, AX-16, AX-18).
 */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  /* AX-14: no horizontal page scroll at any width or zoom. Tables scroll
     inside their own container; the page never does. */
  overflow-x: clip;
  background: var(--surface-app);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--t-40);
  line-height: var(--lh-40);
  -webkit-font-smoothing: antialiased;
}

body {
  min-height: 100vh;
  min-height: 100dvh;
}

h1,
h2,
h3,
h4 {
  margin: 0;
  font-weight: var(--fw-semibold);
  letter-spacing: 0;
}

h1 {
  font-size: var(--t-70);
  line-height: var(--lh-70);
}

h2 {
  font-size: var(--t-60);
  line-height: var(--lh-60);
}

h3 {
  font-size: var(--t-50);
  line-height: var(--lh-50);
}

h4 {
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

p {
  margin: 0 0 var(--s-4);
}

a {
  color: var(--text-link);
}

/* Numbers are always tabular; identifiers are always mono (UI_SPEC §2.3). */
.num {
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.label {
  font-size: var(--t-10);
  line-height: var(--lh-10);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  font-weight: var(--fw-semibold);
}

/* Visually hidden, still in the accessibility tree. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* First tab stop on every page, invisible until it has focus (UC-01). */
.skip-link {
  position: absolute;
  top: 0;
  left: var(--s-4);
  display: inline-flex;
  align-items: center;
  min-height: var(--target-min);
  padding: var(--s-2) var(--s-4);
  background: var(--surface-raised);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--r-2);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  text-decoration: none;
  transform: translateY(-200%);
  transition: transform var(--dur-1) var(--ease-standard);
}

.skip-link:focus-visible {
  top: var(--s-2);
  z-index: var(--z-toast);
  transform: translateY(0);
  text-decoration: none;
}

/* AX-18: outline, never box-shadow, never removed. */
:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
  border-radius: inherit;
}

/* AX-16: every duration collapses, the spinner stops, progress jumps. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  .spinner {
    animation: none;
  }

  .progress-meter > i {
    transition: none;
  }
}
`;

/** shell.css */
export const shellCss = String.raw`/*
 * App shell — top status strip, left rail, breadcrumb, content region and the
 * four responsive bands (UI_SPEC §4.1, §5 UC-01/UC-02/UC-23, §7).
 *
 * Desktop-first, as the specification is: the >=1024 layout is the base, the
 * two narrow bands narrow it honestly rather than hiding the surface.
 */

.shell {
  display: grid;
  grid-template-columns: var(--rail-expanded) minmax(0, 1fr);
  grid-template-rows: var(--strip-height) minmax(0, 1fr);
  grid-template-areas: 'strip strip' 'rail main';
  min-height: 100vh;
  min-height: 100dvh;
}

/* ── global status strip (UC-01, UC-23, IP-07) ───────────────────────────── */

.status-strip {
  grid-area: strip;
  position: sticky;
  top: 0;
  z-index: var(--z-banner);
  display: flex;
  align-items: center;
  gap: var(--s-5);
  height: var(--strip-height);
  padding: 0 var(--s-6);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-secondary);
}

.status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: var(--r-full);
  background: var(--success);
}

.status-strip[data-state='degraded'] .status-dot {
  background: var(--warning);
}

.status-strip[data-state='not-ready'] .status-dot {
  background: var(--danger);
}

.status-word {
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  white-space: nowrap;
}

.status-strip[data-state='degraded'] .status-word {
  color: var(--warning);
}

.status-strip[data-state='not-ready'] .status-word {
  color: var(--danger);
}

.status-cause {
  color: var(--text-secondary);
  text-decoration: none;
}

.status-cause:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.status-count,
.status-attention,
.status-freshness {
  color: var(--text-tertiary);
  white-space: nowrap;
}

.status-freshness[data-stale='true'] {
  color: var(--warning);
}

.status-operator {
  margin-left: auto;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* ── left rail (UC-01, UX §2.2) ──────────────────────────────────────────── */

.rail {
  grid-area: rail;
  position: sticky;
  top: var(--strip-height);
  width: var(--rail-expanded);
  height: calc(100vh - var(--strip-height));
  height: calc(100dvh - var(--strip-height));
  overflow-y: auto;
  padding: var(--s-5) 0;
  background: var(--surface-panel);
  border-right: 1px solid var(--border-subtle);
}

.rail-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rail-item {
  flex: 0 0 auto;
}

.rail-settings {
  margin-top: auto;
  padding-top: var(--s-4);
  border-top: 1px solid var(--border-subtle);
}

.rail-link {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-height: 36px;
  padding: 0 var(--s-6);
  color: var(--text-secondary);
  border-left: 2px solid transparent;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  text-decoration: none;
  transition:
    background-color var(--dur-1) var(--ease-standard),
    border-color var(--dur-1) var(--ease-standard),
    color var(--dur-1) var(--ease-standard);
}

.rail-link:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.rail-link[aria-current='page'] {
  background: var(--surface-selected);
  border-left-color: var(--accent);
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
}

.rail-glyph {
  display: none;
  font-family: var(--font-mono);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  letter-spacing: 0.04em;
}

.rail-label {
  flex: 1 1 auto;
  white-space: nowrap;
}

.rail-badge {
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--r-full);
  background: var(--accent-fill);
  color: #ffffff;
  font-family: var(--font-mono);
  font-size: var(--t-10);
  font-weight: var(--fw-bold);
  line-height: 20px;
  text-align: center;
}

/* ── main region, breadcrumb and page title ──────────────────────────────── */

.main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: var(--s-8);
}

.content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
}

.mobile-bar {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  height: var(--mobile-bar-height);
  margin: 0 0 var(--s-5);
  border-bottom: 1px solid var(--border-subtle);
}

.mobile-back,
.mobile-home,
.mobile-attention {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  min-height: var(--target-min);
  color: var(--text-secondary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  text-decoration: none;
  white-space: nowrap;
}

.mobile-attention,
.mobile-home {
  font-variant-numeric: tabular-nums;
}

.breadcrumb {
  margin: 0 0 var(--s-5);
  font-family: var(--font-mono);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-secondary);
}

.breadcrumb ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.breadcrumb li {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
}

.breadcrumb li + li::before {
  content: '\203A'; /* › */
  color: var(--text-tertiary);
}

.breadcrumb a {
  color: var(--text-secondary);
  text-decoration: none;
}

.breadcrumb a:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.breadcrumb [aria-current='page'] {
  color: var(--text-secondary);
}

.page-title {
  margin: 0 0 var(--s-6);
}

/* ── degraded banner (UC-23, IP-07) ──────────────────────────────────────── */

.degraded-banner {
  margin: 0 0 var(--s-8);
  padding: var(--s-5) var(--s-6);
  background: var(--surface-warning-tint);
  border: 1px solid var(--warning);
  border-left-width: 4px;
  border-radius: var(--r-3);
}

.degraded-banner h2 {
  margin: 0 0 var(--s-3);
  font-size: var(--t-40);
  line-height: var(--lh-40);
  color: var(--warning);
}

.degraded-detail {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--s-2) var(--s-5);
  margin: 0 0 var(--s-3);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.degraded-detail dt {
  color: var(--text-tertiary);
  font-size: var(--t-20);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.degraded-detail dd {
  margin: 0;
  color: var(--text-primary);
  max-width: 92ch;
}

.degraded-more {
  margin: 0 0 var(--s-3);
  color: var(--text-secondary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.degraded-link {
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

/* ── content grid and workspace footer (UI_SPEC §4.1) ────────────────────── */

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s-8);
  align-items: start;
}

.content-main,
.impact-column {
  min-width: 0;
}

.workspace-footer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--s-5);
  height: var(--footer-height);
  margin-top: auto;
  padding: 0 var(--s-4);
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-tertiary);
}

/* ── band ≥1440: full workbench ──────────────────────────────────────────── */

@media (min-width: 1440px) {
  .shell {
    grid-template-columns: var(--rail-expanded) minmax(0, 1fr);
  }

  .content-grid.has-aside {
    grid-template-columns: minmax(0, 1fr) var(--aside-wide);
  }

  .rail-label {
    position: static;
  }
}

/* ── band 1024–1439: compressed workbench ────────────────────────────────── */

@media (min-width: 1024px) and (max-width: 1439px) {
  .shell {
    grid-template-columns: var(--rail-compact) minmax(0, 1fr);
  }

  .main {
    padding: var(--s-7);
  }

  .content-grid.has-aside {
    grid-template-columns: minmax(0, 1fr) var(--aside-compact);
  }

  .rail {
    width: var(--rail-compact);
  }

  .rail-link {
    justify-content: center;
    gap: var(--s-2);
    padding: 0;
  }

  .rail-glyph {
    display: block;
  }

  /* The label becomes the link's accessible name and its tooltip. */
  .rail-label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .rail-badge {
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    font-size: 10px;
    line-height: 16px;
  }

  .rail-item {
    position: relative;
  }

  .rail-settings .rail-link {
    padding: 0;
  }
}

/* ── band ≤1023: review-lite — rail hidden behind a top bar ──────────────── */

@media (max-width: 1023px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'strip' 'main';
  }

  .rail {
    display: none;
  }

  .main {
    padding: var(--s-5);
  }

  .mobile-bar {
    display: flex;
  }

  /* §7.2: service word only; the word itself carries the degradation. */
  .status-cause {
    display: none;
  }

  .status-count {
    display: none;
  }

  .status-freshness {
    display: none;
  }

  .status-operator {
    display: none;
  }

  .status-attention {
    display: none;
  }

  .content-grid.has-aside {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-6);
  }
}

/* ── band ≤767: monitoring — service word only, no counters (AX-22) ──────── */

@media (max-width: 767px) {
  .status-count {
    display: none;
  }

  .status-operator {
    display: none;
  }

  .status-freshness {
    display: none;
  }

  .status-attention {
    display: none;
  }

  .workspace-footer {
    position: static;
  }
}

/* ── band ≤480: phone — 16 px page padding, single column ────────────────── */

@media (max-width: 480px) {
  .main {
    padding: var(--s-6);
  }

  .content-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .status-strip {
    padding: 0 var(--s-4);
  }
}
`;

/** auth.css */
export const authCss = String.raw`/*
 * Auth surfaces — S-01 Login (UI_SPEC §6.1) and the SY-3 system page.
 *
 * S-01 is the only screen without the app shell: one centred 400 px card on
 * the app surface. Every measurement below is the §6.1 table; colours come
 * from tokens.css, with one measured exception: the primary button's label is
 * #FFFFFF (UI_SPEC §8.2 measures it at 5.72:1 on --accent-fill).
 */

.auth {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  min-height: 100vh;
  min-height: 100dvh;
  padding: var(--s-12) var(--s-8) var(--s-10);
  background: var(--surface-app);
}

.auth-main {
  width: 100%;
  max-width: 400px;
  min-width: 0;
}

/* ── SY-2 banner above the card (UI_SPEC §6.1) ───────────────────────────── */

.auth-notice {
  margin: 0 0 var(--s-6);
  padding: var(--s-5) var(--s-6);
  border-left: 4px solid var(--warning);
  background: var(--surface-warning-tint);
  border-radius: var(--r-2);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-primary);
}

.auth-notice p {
  margin: 0;
}

.auth-notice[data-kind='required'] {
  border-left-color: var(--accent);
  background: var(--surface-selected);
}

/* ── S-01 card ───────────────────────────────────────────────────────────── */

.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  box-shadow: var(--e-1);
  padding: var(--s-9);
}

.login-wordmark {
  margin: 0;
  font-size: var(--t-80);
  line-height: var(--lh-80);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.login-subline {
  margin: var(--s-4) 0 var(--s-8);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-secondary);
}

.login-form {
  display: block;
}

.login-field {
  margin-bottom: var(--s-6);
}

.login-label {
  display: block;
  margin-bottom: var(--s-2);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.login-password {
  position: relative;
}

.login-input {
  display: block;
  width: 100%;
  height: var(--target-review);
  padding: 0 var(--s-4);
  background: var(--surface-inset);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--r-2);
  font-family: inherit;
  font-size: var(--t-40);
  line-height: var(--lh-40);
}

.login-input:hover {
  border-color: var(--border-strong);
}

.login-password .login-input {
  padding-right: var(--s-11);
}

.login-reveal {
  position: absolute;
  top: 6px;
  right: var(--s-2);
  min-width: 32px;
  height: 32px;
  padding: 0 var(--s-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-2);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--t-10);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.login-reveal:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.login-error {
  margin: var(--s-4) 0 0;
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--danger);
}

.login-error span[aria-hidden='true'] {
  margin-right: var(--s-1);
}

/* 24 px below the password on an empty form: the field block owns 16 px, the
   error adds 8, the button adds the remaining 24. */
.login-field:last-of-type {
  margin-bottom: var(--s-8);
}

.login-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  width: 100%;
  height: var(--target-review);
  margin-top: var(--s-8);
  background: var(--accent-fill);
  color: #ffffff;
  border: 1px solid transparent;
  border-radius: var(--r-2);
  font-family: inherit;
  font-size: var(--t-40);
  line-height: var(--lh-40);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-standard);
}

.login-submit:hover {
  background: var(--accent-fill-hover);
}

/* The one use of the inverse flash in the product (--surface-inverse token). */
.login-submit:active {
  background: var(--surface-inverse);
  color: var(--text-inverse);
}

.login-submit[disabled] {
  background: var(--control-fill);
  color: var(--text-secondary);
  cursor: progress;
}

.login-note {
  margin: var(--s-8) 0 0;
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-tertiary);
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--r-full);
  animation: auth-spin var(--spin-duration) linear infinite;
}

.spinner[hidden] {
  display: none;
}

@keyframes auth-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── SY-3 not found / no access ──────────────────────────────────────────── */

.system-card {
  width: 100%;
  max-width: 400px;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  box-shadow: var(--e-1);
  padding: var(--s-9);
}

.system-code {
  margin: 0 0 var(--s-2);
  font-family: var(--font-mono);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-tertiary);
}

.system-title {
  margin: 0 0 var(--s-4);
  font-size: var(--t-70);
  line-height: var(--lh-70);
}

.system-body {
  margin: 0 0 var(--s-8);
  font-size: var(--t-40);
  line-height: var(--lh-40);
  color: var(--text-secondary);
}

.system-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--target-review);
  padding: 0 var(--s-6);
  background: var(--accent-fill);
  color: #ffffff;
  border-radius: var(--r-2);
  font-size: var(--t-40);
  font-weight: var(--fw-semibold);
  text-decoration: none;
}

.system-action:hover {
  background: var(--accent-fill-hover);
  text-decoration: none;
}

.system-note {
  margin: var(--s-8) 0 0;
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-tertiary);
}

/* AX-16: the only loop in the product stops. */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

/* AX-14: phone band keeps 16 px page padding and a full-width card. */
@media (max-width: 480px) {
  .auth {
    padding: var(--s-8) var(--s-6) var(--s-10);
  }

  .login-card,
  .system-card {
    padding: var(--s-6);
  }
}
`;
export const APP_CSS = [tokensCss, baseCss, shellCss, authCss].join('\n');
