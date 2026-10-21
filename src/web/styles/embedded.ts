// GENERATED FILE — do not edit by hand.
//
// Source of truth: src/web/styles/tokens.css, base.css, shell.css, auth.css,
// series.css, workspace.css and narration.css (UI_SPEC §2, §4, §6.1, §6.2, §6.5,
// §7, §9.6).
// Regenerate with `npx tsx scripts/generate-embedded-css.ts`;
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

/** series.css */
export const seriesCss = String.raw`/*
 * Series surfaces — S-03 list and S-04 editor (UI_SPEC §4.1/§4.3/§4.4, §5
 * UC-17/UC-18/UC-19/UC-21, §7.2, §9.6).
 *
 * Tokens only. The single raw colour is the measured #FFFFFF label on the
 * accent fill (UI_SPEC §8.2: 5.72:1), the same exception auth.css takes.
 */

/* ── shared controls (UC-18) ─────────────────────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  min-height: 32px;
  padding: 0 var(--s-5);
  border: 1px solid var(--border-default);
  border-radius: var(--r-2);
  background: var(--control-fill);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--t-30);
  font-weight: var(--fw-semibold);
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
}

.btn:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.btn:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

.btn:disabled,
.btn[aria-disabled='true'] {
  background: var(--control-fill);
  color: var(--text-disabled);
  border-color: var(--border-subtle);
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent-fill);
  border-color: var(--accent-fill);
  color: #ffffff;
}

.btn-primary:hover {
  background: var(--accent-fill-hover);
  border-color: var(--accent-fill-hover);
}

.btn-primary:disabled {
  background: var(--control-fill);
  border-color: var(--border-subtle);
  color: var(--text-disabled);
}

/* ── S-03 list ───────────────────────────────────────────────────────────── */

.series-list {
  display: block;
  min-width: 0;
}

.series-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-6);
  margin-bottom: var(--s-6);
}

.series-count {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--t-20);
}

.series-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  overflow: hidden;
}

.series-table caption {
  text-align: left;
}

.series-table thead th {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky-head);
  height: 28px;
  padding: 0 var(--s-5);
  background: var(--surface-raised);
  color: var(--text-tertiary);
  font-size: var(--t-10);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}

.series-table tbody tr {
  height: 44px;
}

.series-table tbody tr:hover {
  background: var(--surface-hover);
}

.series-table th:first-child,
.series-table td:first-child {
  width: 34%;
}

.series-table tbody td:not(:first-child),
.series-table thead th:not(:first-child) {
  white-space: nowrap;
}

.series-table tbody td {
  padding: 0 var(--s-5);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-size: var(--t-30);
  vertical-align: middle;
}

.series-table tbody tr:last-child td {
  border-bottom: 0;
}

.series-name {
  color: var(--text-link);
  font-weight: var(--fw-semibold);
  text-decoration: none;
}

.series-name:hover {
  text-decoration: underline;
}

.series-open {
  color: var(--text-link);
  font-size: var(--t-30);
}

.series-version {
  display: inline-block;
  padding: 0 var(--s-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-1);
  background: var(--surface-inset);
  color: var(--text-primary);
  font-size: var(--t-10);
  font-variant-numeric: tabular-nums;
  line-height: var(--lh-10);
}

.series-status {
  display: inline-block;
  padding: 0 var(--s-3);
  border: 1px dashed var(--border-default);
  border-radius: var(--r-1);
  color: var(--text-secondary);
  font-size: var(--t-10);
  line-height: var(--lh-10);
}

.series-status[data-status='active'] {
  border-style: solid;
  border-color: var(--success);
  color: var(--success);
}

.series-status-note {
  display: block;
  color: var(--text-tertiary);
  font-size: var(--t-20);
}

.series-skeleton {
  display: block;
  height: var(--s-5);
  width: 80%;
  border-radius: var(--r-1);
  background: var(--surface-inset);
}

.series-empty,
.series-error {
  max-width: 320px;
  margin: var(--s-12) auto;
  text-align: center;
}

.series-empty-line,
.series-error p {
  color: var(--text-secondary);
  font-size: var(--t-40);
}

.series-error h2 {
  color: var(--text-primary);
  font-size: var(--t-60);
}

.series-empty .btn-primary {
  height: var(--target-review);
  margin-top: var(--s-6);
  padding: 0 var(--s-8);
}

.series-empty .btn-primary:hover {
  background: var(--accent-fill-hover);
}

/* ── S-04 editor ─────────────────────────────────────────────────────────── */

.series-editor {
  display: block;
  min-width: 0;
}

.series-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
  margin: 0 0 var(--s-6);
  color: var(--text-secondary);
  font-size: var(--t-20);
}

.series-meta-item {
  padding-left: var(--s-3);
  border-left: 1px solid var(--border-subtle);
}

.series-meta .series-version {
  margin-right: var(--s-1);
}

.series-form {
  display: block;
  max-width: 720px;
}

.series-block {
  margin: 0 0 var(--s-9);
  padding: 0;
  border: 0;
}

.series-block legend {
  padding: 0 0 var(--s-5);
  color: var(--text-primary);
  font-size: var(--t-60);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-60);
}

.series-fields {
  display: flex;
  flex-direction: column;
  gap: var(--s-7);
}

.series-field {
  display: grid;
  grid-template-columns: 160px minmax(0, 420px);
  column-gap: var(--s-6);
  row-gap: var(--s-2);
  align-items: start;
}

.series-label-row {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.series-label {
  color: var(--text-primary);
  font-size: var(--t-30);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-30);
}

.series-control-cell {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
}

.series-control-wrap {
  position: relative;
  display: block;
}

.series-control {
  display: block;
  width: 100%;
  height: 32px;
  padding: 0 var(--s-4);
  border: 1px solid var(--border-default);
  border-radius: var(--r-2);
  background: var(--surface-inset);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--t-40);
  line-height: var(--lh-40);
}

textarea.series-control {
  height: auto;
  min-height: 88px;
  padding: var(--s-3) var(--s-4);
  resize: vertical;
}

.series-control:hover {
  border-color: var(--border-strong);
}

.series-control:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
  border-color: var(--accent);
}

.series-control[aria-invalid='true'] {
  border-color: var(--danger);
}

.series-control:disabled,
.series-control[readonly] {
  background: var(--surface-inset);
  color: var(--text-secondary);
  border-color: var(--border-subtle);
  cursor: default;
}

.series-unit {
  position: absolute;
  top: 0;
  right: var(--s-4);
  height: 32px;
  display: flex;
  align-items: center;
  color: var(--text-secondary);
  font-size: var(--t-30);
  pointer-events: none;
}

.series-check {
  width: 24px;
  height: 24px;
  accent-color: var(--accent);
}

.series-radio-option {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: var(--s-3);
  row-gap: var(--s-1);
  align-items: center;
  padding: var(--s-2) 0;
}

.series-radio {
  grid-row: span 2;
  width: 24px;
  height: 24px;
  accent-color: var(--accent);
}

.series-radio-label {
  color: var(--text-primary);
  font-size: var(--t-40);
}

.series-help {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.series-field-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.series-changed {
  display: inline-block;
  padding: 0 var(--s-2);
  border: 1px solid var(--accent);
  border-radius: var(--r-1);
  background: var(--surface-selected);
  color: var(--accent);
  font-size: var(--t-10);
  line-height: var(--lh-10);
}

.series-changed[hidden] {
  display: none;
}

.series-readonly {
  display: block;
  padding: var(--s-2) var(--s-4);
  background: var(--surface-inset);
  color: var(--text-secondary);
  font-size: var(--t-30);
}

.series-archived,
.series-conflict,
.series-saved,
.series-unchanged,
.series-save-error {
  margin: 0 0 var(--s-6);
  padding: var(--s-5) var(--s-6);
  border-radius: var(--r-2);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.series-archived {
  border-left: 4px solid var(--warning);
  background: var(--surface-warning-tint);
  color: var(--text-primary);
}

.series-conflict {
  border-left: 4px solid var(--danger);
  background: var(--surface-danger-tint);
  color: var(--text-primary);
}

.series-conflict h2,
.series-save-error h2 {
  margin: 0 0 var(--s-2);
  font-size: var(--t-50);
  line-height: var(--lh-50);
}

.series-conflict p,
.series-save-error p {
  margin: 0 0 var(--s-3);
}

.series-conflict .btn {
  margin-top: var(--s-2);
}

.series-saved {
  border-left: 4px solid var(--success);
  background: var(--surface-success-tint);
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
}

.series-unchanged {
  border-left: 4px solid var(--accent);
  background: var(--surface-selected);
  color: var(--text-primary);
}

.series-save-error {
  border-left: 4px solid var(--danger);
  background: var(--surface-danger-tint);
  color: var(--text-primary);
}

/* ── IP-02 commit panel ──────────────────────────────────────────────────── */

.series-commit {
  display: block;
  padding: var(--s-7);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
}

.series-commit-heading {
  margin: 0 0 var(--s-4);
  color: var(--text-primary);
  font-size: var(--t-50);
  line-height: var(--lh-50);
  font-weight: var(--fw-semibold);
}

.series-commit-lead {
  margin: 0 0 var(--s-3);
  color: var(--text-primary);
  font-size: var(--t-40);
  line-height: var(--lh-40);
  font-weight: var(--fw-semibold);
}

.series-commit-body {
  margin: 0 0 var(--s-6);
  color: var(--text-secondary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.series-change-heading {
  margin: 0 0 var(--s-3);
  color: var(--text-tertiary);
  font-size: var(--t-10);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.series-summary {
  margin: 0 0 var(--s-4);
  padding: 0;
  list-style: none;
}

.series-summary li {
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-size: var(--t-30);
  font-variant-numeric: tabular-nums;
}

.series-summary li[hidden] {
  display: none;
}

.series-change-empty {
  margin: 0 0 var(--s-4);
  color: var(--text-tertiary);
  font-size: var(--t-30);
}

.series-change-empty[hidden] {
  display: none;
}

.series-commit .btn-primary {
  display: flex;
  width: 100%;
  height: var(--target-review);
  margin-top: var(--s-5);
  font-size: var(--t-40);
}

.series-commit-reason {
  margin: var(--s-3) 0 0;
  color: var(--text-tertiary);
  font-size: var(--t-20);
}

.series-commit-reason[hidden] {
  display: none;
}

.series-noscript {
  margin: var(--s-3) 0 0;
  color: var(--text-tertiary);
  font-size: var(--t-20);
}

.series-commit .spinner[hidden] {
  display: none;
}

/* ── responsive (UI_SPEC §7) ─────────────────────────────────────────────── */

@media (max-width: 1023px) {
  .series-field {
    grid-template-columns: minmax(0, 1fr);
    row-gap: var(--s-2);
  }
}

@media (max-width: 767px) {
  .series-table,
  .series-table tbody,
  .series-table td {
    display: block;
    width: 100%;
  }

  .series-table {
    overflow-x: hidden;
    border: 0;
    background: transparent;
  }

  .series-table thead {
    display: none;
  }

  .series-table tr {
    display: block;
    margin-bottom: var(--s-5);
    padding: var(--s-4) var(--s-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-3);
    background: var(--surface-panel);
  }

  .series-table tbody tr {
    height: auto;
  }

  .series-table tbody td {
    display: flex;
    justify-content: space-between;
    gap: var(--s-5);
    padding: var(--s-1) 0;
    border-bottom: 0;
  }

  .series-table tbody td::before {
    content: attr(data-label);
    color: var(--text-tertiary);
    font-size: var(--t-10);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
}

@media (max-width: 480px) {
  .series-editor {
    padding: var(--s-6);
  }

  .series-commit {
    padding: var(--s-6);
  }
}
`;

/** workspace.css */
export const workspaceCss = String.raw`/*
 * F-04 workspace surfaces — UI_SPEC §3 (state palette), §5 UC-02/UC-03/UC-04/
 * UC-05, §6.2 W-01 and §6.5 W-04; §7 responsive bands.
 *
 * Every state carries four channels: colour, glyph, word and the border
 * structure that gives it a distinct silhouette (UI_SPEC §3.2). Nothing below
 * relies on hue alone, and no value is invented — colour, spacing, radii,
 * motion and geometry all come from tokens.css.
 */

/* ── page head with the workspace chip (W-04 title row) ──────────────────── */

.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-5);
  margin: 0 0 var(--s-6);
}

.page-head .page-title {
  margin: 0;
}

.workspace-status {
  display: inline-flex;
  align-items: center;
  gap: var(--s-4);
  flex-wrap: wrap;
}

.workspace-reason {
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-secondary);
}

/* ── UC-04 video state chip ──────────────────────────────────────────────── */

.vchip {
  display: inline-flex;
  align-items: center;
  gap: var(--s-3);
  height: 20px;
  padding: 0 var(--s-3);
  border: 1px solid var(--border-default);
  border-radius: var(--r-1);
  color: var(--text-tertiary);
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--t-10);
  font-weight: var(--fw-bold);
  line-height: var(--lh-10);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  transition: color var(--dur-1) var(--ease-standard);
}

.vchip[data-size='md'] {
  height: 24px;
  padding: 0 var(--s-4);
  font-size: var(--t-20);
  font-weight: var(--fw-semibold);
  letter-spacing: 0;
  text-transform: none;
}

.vchip[data-size='lg'] {
  height: 28px;
  padding: 0 var(--s-5);
  font-size: var(--t-20);
  font-weight: var(--fw-semibold);
  letter-spacing: 0;
  text-transform: none;
}

.vchip-glyph {
  display: inline-flex;
  align-items: center;
}

.vchip .glyph {
  display: block;
}

.vchip[data-state='running'] {
  color: var(--running);
  background: rgba(79, 209, 224, 0.08);
  border-color: var(--running);
}

.vchip[data-state='done'] {
  color: var(--success);
  background: rgba(76, 194, 106, 0.1);
  border-color: var(--success);
}

.vchip[data-state='awaiting_approval'] {
  color: var(--accent);
  background: rgba(126, 166, 248, 0.1);
  border-color: var(--accent);
  border-right-width: 3px; /* the gate notch (§3.2) */
}

.vchip[data-state='stale'] {
  color: var(--stale);
  border: 1px dashed var(--stale);
  background: repeating-linear-gradient(
    135deg,
    rgba(187, 161, 255, 0.14) 0 2px,
    transparent 2px 6px
  );
}

.vchip[data-state='failed'] {
  color: var(--danger);
  background: var(--surface-danger-tint);
  border-color: var(--danger);
  border-left-width: 4px;
}

.vchip[data-state='blocked'] {
  color: var(--warning);
  background: var(--surface-warning-tint);
  border: 3px double var(--warning);
}

.vchip[data-state='cancelled'] {
  color: var(--cancelled);
  border-color: var(--border-default);
}

.vchip[data-state='cancelled'] .vchip-label {
  text-decoration: line-through;
}

/* ── UC-03 stage rail ────────────────────────────────────────────────────── */

.stage-rail {
  margin: 0 0 var(--s-6);
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.stage-rail-head {
  display: flex;
  align-items: stretch;
  gap: var(--s-4);
}

.stage-list {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stage-node {
  flex: 1 1 0;
  min-width: 74px;
  border-right: 1px solid var(--border-subtle);
}

.stage-node:last-child {
  border-right: 0;
}

.stage-link {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--s-1);
  height: 56px;
  padding: var(--s-2) var(--s-3);
  color: inherit;
  text-decoration: none;
}

.stage-link:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: calc(-1 * var(--focus-ring-offset));
}

.stage-node[data-current='true'] .stage-link {
  background: var(--surface-selected);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.stage-code {
  font-size: var(--t-20);
  font-weight: var(--fw-bold);
  line-height: var(--lh-20);
  color: var(--text-secondary);
}

.stage-state {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.stage-glyph {
  display: inline-flex;
  align-items: center;
}

.stage-glyph .glyph {
  display: block;
}

.stage-pin {
  align-self: flex-start;
  padding-left: var(--s-2);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  color: var(--text-tertiary);
}

.stage-gate {
  /* Bottom-right, on the pin line: the top row belongs to the code and the
     state word, and a gate tag there collides with both at 88 px. */
  position: absolute;
  right: var(--s-2);
  bottom: var(--s-1);
  padding: 0 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-1);
  font-size: 9px;
  line-height: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.stage-progress {
  display: block;
  height: 2px;
  margin-top: var(--s-1);
  background: var(--surface-hover);
}

.stage-progress[hidden] {
  display: none;
}

.stage-bar {
  display: block;
  height: 2px;
  width: var(--pct, 0%);
  background: var(--running);
  transition: width var(--progress-duration) var(--ease-standard);
}

/* state colours on the rail — the word and glyph carry the meaning */
.stage-node[data-state='not_run'] .stage-state {
  color: var(--text-tertiary);
}

.stage-node[data-state='running'] .stage-code,
.stage-node[data-state='running'] .stage-state {
  color: var(--running);
}

.stage-node[data-state='running'] .stage-glyph {
  animation: stage-spin var(--spin-duration) linear infinite;
}

.stage-node[data-state='done'] .stage-state {
  color: var(--success);
}

.stage-node[data-state='awaiting_approval'] .stage-code,
.stage-node[data-state='awaiting_approval'] .stage-state {
  color: var(--accent);
}

.stage-node[data-state='stale'] .stage-link {
  background: repeating-linear-gradient(
    135deg,
    rgba(187, 161, 255, 0.14) 0 2px,
    transparent 2px 6px
  );
}

.stage-node[data-state='stale'] .stage-state {
  color: var(--stale);
}

.stage-node[data-state='failed'] .stage-link {
  background: rgba(255, 123, 114, 0.08);
}

.stage-node[data-state='failed'] .stage-state {
  color: var(--danger);
}

.stage-node[data-state='blocked'] .stage-code,
.stage-node[data-state='blocked'] .stage-state {
  color: var(--warning);
}

.stage-node[data-state='cancelled'] .stage-state {
  color: var(--cancelled);
  text-decoration: line-through;
}

@keyframes stage-spin {
  to {
    transform: rotate(360deg);
  }
}

.stage-stale-summary {
  align-self: center;
  flex: 0 0 auto;
  margin: 0;
  padding-right: var(--s-4);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* ── UC-05 stale ribbon ──────────────────────────────────────────────────── */

.stage-ribbons {
  display: block;
}

.stale-ribbon {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-4);
  min-height: 28px;
  padding: 0 var(--s-4);
  background: var(--surface-stale-tint);
  border-top: 1px dashed var(--stale);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--stale);
}

.stale-ribbon[hidden] {
  display: none;
}

.stale-ribbon-list {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-1);
  font-family: var(--font-mono);
  font-size: var(--t-20);
}

.stale-ribbon-stage {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
}

.stale-ribbon-cause {
  color: var(--text-secondary);
  font-size: var(--t-20);
}

.stale-ribbon-why {
  margin-left: auto;
  font-size: var(--t-20);
  color: var(--text-secondary);
}

.stale-ribbon-why summary {
  min-height: var(--target-min);
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  color: var(--text-link);
}

.stale-ribbon-why p {
  flex-basis: 100%;
  margin: var(--s-2) 0 var(--s-3);
  max-width: 80ch;
  color: var(--text-secondary);
}

/* ── UC-02 workspace tabs ────────────────────────────────────────────────── */

.workspace-tablist {
  display: flex;
  align-items: stretch;
  gap: var(--s-1);
  overflow-x: auto;
  border-bottom: 1px solid var(--border-subtle);
  margin: 0 0 var(--s-6);
}

.workspace-tab {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 var(--s-5);
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
  text-decoration: none;
  white-space: nowrap;
}

.workspace-tab:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.workspace-tab[aria-selected='true'] {
  border-bottom-color: var(--accent);
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
}

.workspace-tab:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: calc(-1 * var(--focus-ring-offset));
}

.workspace-panel {
  min-width: 0;
}

.workspace-panel:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

/* ── stage summary cards (the shell's honest per-stage panel) ────────────── */

.stage-summary {
  margin: 0 0 var(--s-6);
  padding: var(--s-6);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
}

.stage-summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-5);
  margin-bottom: var(--s-5);
  flex-wrap: wrap;
}

.stage-summary-head h2 {
  margin: 0;
  font-size: var(--t-50);
  line-height: var(--lh-50);
}

.stage-summary-dl {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: var(--s-2) var(--s-5);
  margin: 0;
  font-size: var(--t-40);
  line-height: var(--lh-40);
}

.stage-summary-dl dt {
  color: var(--text-tertiary);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-top: var(--s-2);
}

.stage-summary-dl dd {
  margin: 0;
  color: var(--text-primary);
  max-width: 92ch;
}

/* ── S-02 overview / attention queue ─────────────────────────────────────── */

.overview {
  min-width: 0;
}

.overview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-5);
  margin: 0 0 var(--s-6);
}

.overview-head h2 {
  margin: 0;
  font-size: var(--t-70);
  line-height: var(--lh-70);
}

.overview-count {
  color: var(--accent);
  font-size: var(--t-60);
}

.overview-new {
  margin: 0 0 var(--s-5);
  padding: var(--s-4) var(--s-5);
  background: var(--surface-warning-tint);
  border: 1px solid var(--warning);
  border-radius: var(--r-3);
  color: var(--text-primary);
  font-size: var(--t-30);
}

.overview-none {
  margin: 0 0 var(--s-6);
  color: var(--text-secondary);
}

.attention-card {
  margin: 0 0 var(--s-5);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  overflow: hidden;
}

.attention-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-5);
  padding: var(--s-3) var(--s-6);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-raised);
}

.attention-group-title {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  font-weight: var(--fw-semibold);
}

.attention-batch {
  color: var(--text-tertiary);
  font-size: var(--t-20);
}

.attention-progress {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: var(--t-20);
}

.attention-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.attention-row {
  display: grid;
  grid-template-columns:
    var(--s-11) minmax(0, 160px) minmax(0, 200px) minmax(0, 1fr)
    var(--s-11) var(--s-11);
  align-items: center;
  gap: var(--s-5);
  min-height: var(--s-11);
  padding: var(--s-2) var(--s-6);
  border-bottom: 1px solid var(--border-subtle);
}

.attention-row:last-child {
  border-bottom: 0;
}

.attention-row:hover {
  background: var(--surface-hover);
}

.attention-position {
  font-weight: var(--fw-bold);
  color: var(--text-primary);
}

.attention-label {
  color: var(--text-secondary);
  font-size: var(--t-30);
  overflow-wrap: anywhere;
}

.attention-reason {
  color: var(--text-secondary);
  font-size: var(--t-30);
  overflow-wrap: anywhere;
}

.attention-detail {
  color: var(--text-tertiary);
  font-size: var(--t-20);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.attention-age {
  color: var(--text-tertiary);
  font-size: var(--t-20);
  text-align: right;
  white-space: nowrap;
}

.attention-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--target-min);
  padding: 0 var(--s-3);
  border: 1px solid var(--border-default);
  border-radius: var(--r-2);
  color: var(--text-primary);
  font-size: var(--t-20);
  text-decoration: none;
  white-space: nowrap;
}

.attention-open:hover {
  background: var(--surface-hover);
}

.attention-open:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

.attention-card-quiet .attention-quiet-line {
  margin: 0;
  padding: var(--s-5) var(--s-6);
  color: var(--text-tertiary);
  font-size: var(--t-30);
}

/* rows carry a state through a left bar, never colour alone (§3.1) */
.attention-row[data-stage-state='failed'] {
  box-shadow: inset 3px 0 0 var(--danger);
}

.attention-row[data-stage-state='blocked'] {
  box-shadow: inset 3px 0 0 var(--warning);
}

.attention-row[data-stage-state='awaiting_approval'] {
  box-shadow: inset 0 0 0 0 transparent;
}

.attention-row[data-stage-state='stale'] {
  box-shadow: inset 3px 0 0 var(--stale);
}

/* ── overview progress + empty + loading + error ─────────────────────────── */

.overview-progress {
  margin: var(--s-8) 0 0;
  padding-top: var(--s-5);
  border-top: 1px solid var(--border-subtle);
}

.overview-progress h2 {
  margin: 0 0 var(--s-4);
  font-size: var(--t-40);
  line-height: var(--lh-40);
  color: var(--text-secondary);
}

.overview-groups {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-6);
  margin: 0;
  padding: 0;
  list-style: none;
}

.overview-group {
  display: inline-flex;
  align-items: baseline;
  gap: var(--s-3);
}

.overview-group-label {
  color: var(--text-tertiary);
  font-size: var(--t-20);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.overview-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-5);
  max-width: 560px;
  margin: var(--s-9) auto;
  padding: var(--s-8);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
}

.overview-empty-line {
  margin: 0;
  font-size: var(--t-60);
  line-height: var(--lh-60);
}

.overview-empty-quiet {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--t-30);
}

.overview-error {
  max-width: 640px;
  margin: var(--s-9) auto;
  padding: var(--s-8);
  background: var(--surface-panel);
  border: 1px solid var(--danger);
  border-left-width: 4px;
  border-radius: var(--r-3);
}

.overview-error h2 {
  margin: 0 0 var(--s-3);
  font-size: var(--t-60);
  line-height: var(--lh-60);
  color: var(--danger);
}

.overview-error p {
  margin: 0 0 var(--s-5);
  color: var(--text-secondary);
}

.attention-skeleton {
  display: block;
  height: var(--s-5);
  margin: var(--s-4) var(--s-6);
  border-radius: var(--r-2);
  background: var(--surface-hover);
}

.attention-skeleton-head {
  width: 30%;
  height: var(--s-6);
}

.attention-skeleton-row {
  width: 70%;
}

/* ── responsive bands (UI_SPEC §7.1/§7.2) ────────────────────────────────── */

@media (max-width: 1023px) {
  .stage-list {
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .stage-node {
    flex: 0 0 44px;
    min-width: 44px;
  }

  .stage-link {
    align-items: center;
    height: 48px;
    padding: var(--s-1);
    gap: 0;
  }

  /* The word stays in the accessible name; the tooltip carries it visually. */
  .stage-state-word {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .stage-pin {
    display: none;
  }

  .stage-stale-summary {
    display: none;
  }

  .attention-row {
    grid-template-columns: var(--s-11) minmax(0, 1fr) var(--s-11);
    row-gap: var(--s-2);
  }

  .attention-label {
    grid-column: 2;
  }

  .attention-reason,
  .attention-detail {
    grid-column: 2;
  }

  .attention-age {
    grid-column: 2;
    text-align: left;
  }

  .attention-open {
    grid-column: 3;
    grid-row: 1 / span 2;
  }
}

@media (max-width: 767px) {
  .page-head {
    align-items: flex-start;
  }

  .stage-summary {
    padding: var(--s-5);
  }

  .stage-summary-dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .stage-summary-dl dt {
    padding-top: var(--s-4);
  }

  .stale-ribbon {
    padding: var(--s-2) var(--s-4);
  }

  .stale-ribbon-why {
    margin-left: 0;
  }

  .overview-head h2 {
    font-size: var(--t-60);
    line-height: var(--lh-60);
  }

  .attention-row {
    grid-template-columns: var(--s-11) minmax(0, 1fr);
  }

  .attention-open {
    grid-column: 2;
    grid-row: auto;
    justify-self: start;
  }
}

@media (max-width: 480px) {
  .attention-card-head {
    padding: var(--s-3) var(--s-4);
  }

  .attention-row {
    padding: var(--s-3) var(--s-4);
  }

  .vchip[data-size='lg'] {
    height: 24px;
    font-size: var(--t-10);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
}
`;

/** narration.css */
export const narrationCss = String.raw`/*
 * S-14 Narration & timing — US-021, US-022, R-009-3/4; UI_SPEC §2 tokens,
 * §3.2 four-channel states (the chip is the shared renderChip), §7.1/§7.2 bands,
 * §9.6 number formatting.
 *
 * No raw colour: every value comes from tokens.css. The word row that follows
 * playback uses --surface-selected plus an inset accent edge, so the active
 * word is visible in greyscale as well as in colour. Nothing animates beyond a
 * single transition token, and prefers-reduced-motion zeroes those in tokens.
 */

.narration {
  display: flex;
  flex-direction: column;
  gap: var(--s-6);
  padding: var(--s-6) 0 var(--s-8);
}

.narration-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-5);
}

.narration-head h3 {
  margin: 0;
  font-size: var(--t-60);
  line-height: var(--lh-60);
  font-weight: var(--fw-semibold);
}

.narration-summary,
.narration-detail,
.narration-coverage,
.narration-transport {
  margin: 0;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.narration-detail {
  color: var(--text-tertiary);
}

.narration-stale {
  margin: 0;
  padding: var(--s-4) var(--s-5);
  border-left: 3px solid var(--stale);
  border-radius: var(--r-2);
  background: var(--surface-stale-tint);
  color: var(--text-primary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.narration-notice {
  margin: 0;
  padding: var(--s-4) var(--s-5);
  border: 1px solid var(--border-default);
  border-radius: var(--r-3);
  background: var(--surface-raised);
}

.narration-notice p {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.narration-notice[data-notice='success'] {
  border-color: var(--success);
  background: var(--surface-success-tint);
}

.narration-notice[data-notice='error'] {
  border-color: var(--danger);
  background: var(--surface-danger-tint);
}

.narration-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--s-8);
  align-items: start;
}

.narration-player,
.narration-band {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-6);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  background: var(--surface-panel);
}

.narration-player h4,
.narration-band h4,
.narration-timings h4,
.narration-provenance h4,
.narration-accept h4,
.narration-spend h4 {
  margin: 0;
  font-size: var(--t-20);
  line-height: var(--lh-20);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.narration-audio {
  width: 100%;
  height: var(--target-review);
  color-scheme: dark;
}

.narration-transport {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
}

.narration-transport-sep {
  color: var(--text-tertiary);
}

.narration-transcript-link {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.narration-transcript-link a {
  color: var(--text-link);
  min-height: var(--target-min);
  display: inline-flex;
  align-items: center;
}

.narration-note,
.narration-unlock,
.narration-empty,
.narration-words-empty {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-secondary);
}

.narration-reason {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-secondary);
}

.narration-reason[role='note'] {
  color: var(--text-secondary);
}

.narration-empty-action {
  margin: 0;
}

.narration-band-dl,
.narration-provenance-dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--s-2) var(--s-5);
  margin: 0;
}

.narration-kv {
  display: contents;
}

.narration-band-dl dt,
.narration-provenance-dl dt {
  color: var(--text-tertiary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.narration-band-dl dd,
.narration-provenance-dl dd {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  overflow-wrap: anywhere;
}

.narration-verdict {
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  font-weight: var(--fw-semibold);
}

.narration-verdict[data-verdict='within'] {
  color: var(--success);
}

.narration-verdict[data-verdict='outside'] {
  color: var(--danger);
}

.narration-out-of-band {
  padding: var(--s-4) var(--s-5);
  border: 1px solid var(--danger);
  border-left-width: 4px;
  border-radius: var(--r-2);
  background: var(--surface-danger-tint);
}

.narration-out-of-band-sentence {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.narration-out-of-band-action {
  margin: var(--s-4) 0 0;
}

.narration-table-wrap {
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  background: var(--surface-inset);
}

.narration-table-wrap:focus-visible {
  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

.narration-words {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

.narration-words caption {
  padding: var(--s-4) var(--s-5);
  text-align: left;
  color: var(--text-tertiary);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  border-bottom: 1px solid var(--border-subtle);
}

.narration-words thead th {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky-head);
  padding: var(--s-3) var(--s-5);
  text-align: left;
  background: var(--surface-raised);
  color: var(--text-tertiary);
  font-size: var(--t-10);
  line-height: var(--lh-10);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.narration-words tbody th,
.narration-words tbody td {
  padding: var(--s-2) var(--s-5);
  border-top: 1px solid var(--border-subtle);
  font-size: var(--t-20);
  line-height: var(--lh-20);
  font-weight: var(--fw-regular);
  text-align: left;
  color: var(--text-primary);
}

.narration-words tbody th {
  font-family: var(--font-ui);
  font-weight: var(--fw-semibold);
}

.narration-words tbody .narration-time,
.narration-words tbody .narration-span {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  width: 1%;
  white-space: nowrap;
}

.narration-words tbody tr {
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-standard);
}

.narration-words tbody tr:hover {
  background: var(--surface-hover);
}

.narration-words tbody tr[data-active='true'] {
  background: var(--surface-selected);
  box-shadow: inset 3px 0 0 var(--accent);
}

.narration-words tbody tr[data-active='true'] .narration-word {
  color: var(--accent);
}

.narration-monotonic {
  margin: 0;
  padding: var(--s-4) var(--s-5);
  border-left: 3px solid var(--warning);
  border-radius: var(--r-2);
  background: var(--surface-warning-tint);
  color: var(--text-primary);
  font-size: var(--t-30);
  line-height: var(--lh-30);
}

.narration-timings,
.narration-provenance {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.narration-provenance-dl {
  padding: var(--s-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  background: var(--surface-panel);
}

.narration-actions {
  display: flex;
  flex-direction: column;
  gap: var(--s-6);
  padding-top: var(--s-6);
  border-top: 1px solid var(--border-subtle);
}

.narration-accept,
.narration-spend {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: 720px;
}

.narration-accept-button,
.narration-rerun-button,
.narration-rerun-confirm {
  min-height: var(--target-review);
  justify-content: center;
}

.narration-accepted {
  margin: 0;
  color: var(--success);
  font-size: var(--t-20);
  line-height: var(--lh-20);
}

.narration-rerun-summary {
  display: inline-flex;
  align-items: center;
  gap: var(--s-3);
  min-height: var(--target-review);
  width: fit-content;
  list-style: none;
  cursor: pointer;
}

.narration-rerun-summary::-webkit-details-marker {
  display: none;
}

.narration-rerun-summary::before {
  content: '▸';
  color: var(--text-tertiary);
}

.narration-rerun[open] > .narration-rerun-summary::before {
  content: '▾';
}

.narration-rerun-body {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  margin-top: var(--s-4);
  padding: var(--s-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-3);
  background: var(--surface-raised);
}

.narration-rerun-scope {
  margin: 0;
  max-width: 68ch;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-secondary);
}

.narration-rerun-form {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.narration-rerun-form label {
  font-size: var(--t-20);
  line-height: var(--lh-20);
  color: var(--text-tertiary);
}

.narration-rerun-form input {
  min-height: var(--target-review);
  padding: 0 var(--s-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  background: var(--surface-inset);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--t-40);
}

.narration-rerun-cancel {
  align-self: flex-start;
  min-height: var(--target-review);
}

/* §7.1: below 768 px every spend/approval control is absent, with one line. */
.narration-band-note {
  display: none;
  margin: 0;
  font-size: var(--t-30);
  line-height: var(--lh-30);
  color: var(--text-tertiary);
}

@media (max-width: 1023px) {
  .narration-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-6);
  }

  .narration {
    padding-top: var(--s-5);
  }
}

@media (max-width: 767px) {
  .narration-accept,
  .narration-spend {
    display: none;
  }

  .narration-band-note {
    display: block;
  }

  .narration-actions {
    gap: var(--s-4);
  }

  .narration-table-wrap {
    max-height: 280px;
  }

  .narration-words tbody th,
  .narration-words tbody td {
    padding: var(--s-2) var(--s-3);
  }
}

@media (max-width: 480px) {
  .narration-player,
  .narration-band {
    padding: var(--s-5);
  }

  .narration-head h3 {
    font-size: var(--t-50);
    line-height: var(--lh-50);
  }
}
`;
export const APP_CSS = [
  tokensCss,
  baseCss,
  shellCss,
  authCss,
  seriesCss,
  workspaceCss,
  narrationCss,
].join('\n');
