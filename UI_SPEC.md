# UI specification — reels-generator

**Revision:** 1 · **Date:** 2026-10-20 · **Author:** UI designer
**Status:** Complete for technical design and implementation. Dark theme, 24 components, 11 screen mockups (W-01…W-10 + S-01 login), 28 accessibility requirements translated to concrete UI decisions, 25 copy templates bound to exact controls.
**Deliverable of:** Kanban `t_dac0ba5d`.

**Grounded in these artifacts, re-hashed on disk before writing (2026-10-20):**

| Input | Rev | sha256 (verified with `sha256sum`) | Bytes |
|---|---|---|---|
| `PRD.md` | 2.3 | `f9a4d48e86c5677328ee8fadd66fb3653b650a10a7ac371750d96d0c725038f9` | 42,090 |
| `UX_SPEC.md` | 1.0 | `93aeb482bccfe08eb89a6c869906c93c31aba43c3803e1b68a869e5045ebbda5` | 107,896 |
| `BACKLOG.md` | 2.2 | `ced1e2abddbe11dc44cd25d7dcea32cfbf0ce8698d3aaa6a827e5c0832debb66` | 57,094 |
| `APPROVAL.md` | 2.3 | `106eec8042daa27de23706593be5fc74a79c9eb8d1c111e0dc23b1c0d94ecd40` | 4,256 |

Both primary hashes match `PRD_HASHES.md`. The task body's PRD hash is missing its final character; the corrected value in the task comment (`…25038f9`) is what was verified. No decision in `APPROVAL.md` (D1–D13) is re-opened here, and no flow, screen or state from `UX_SPEC.md` is changed. Where this document believes the UX spec has a gap, the item is listed in **§12 Challenges to UX_SPEC** and nowhere else.

**What this document owns.** Colour, type, spacing, iconography, elevation, motion, component anatomy and states, high-fidelity layout and exact measurements, responsive behaviour, the accessibility implementation, the operator-facing strings, and the handoff to technical design.

**What this document does not own.** Flows, information architecture, screen inventory, the state machine, API shapes, job-queue design, or production code. Route strings are IA handles from UX §2.1. This document produces no application source; the two artifacts in `mockups/` and `tools/` are specification evidence, not shipped code.

**Companion artifacts in the workspace:**

| Path | What it is | How it is meant to be used |
|---|---|---|
| `mockups/ui-mockup.html` | Self-contained visual proof (65,729 bytes): tokens, type ramp, all 8 state chips, stage rail, impact panels, scene grid, batch table, retry scope, claims, export integrity, controls, and a full 1440×900 W-05 composition. No network requests, no webfonts, no icon library — 21 inline SVG symbols. | Open at ≥1440 px in a browser. This is the reference an implementer copies values from. |
| `tools/contrast_audit.py` | WCAG 2.2 contrast audit over 52 token pairs; exits non-zero on any failure. | `python3 tools/contrast_audit.py` in CI or before a design change. |
| `tools/contrast_audit.txt` | The captured run this document quotes: **52 pairs, 0 failures**. | Evidence for AX-12. |
| `UI_SPEC.sha256` | Hash of this file, regenerated on change (same convention as `UX_SPEC.sha256`). | `sha256sum -c UI_SPEC.sha256` |

**Verification performed on the mockup artifact:** tag-balance parse (0 unclosed, 0 mismatched, 0 duplicate ids), all 74 `<use>` references resolve to the 21 defined symbols, and a scan for `http://`, `https://` and `@import` returned no matches (zero external requests). No headless browser is installed in this environment, so pixel-level rendering was **not** verified here — that check belongs to the implementing developer's browser pass.

---

## 0. How to read this document

### 0.1 Traceability

Every component and every screen section names the UX id it satisfies — a wireframe (`W-01…W-10`), a screen (`S-01…S-21`), an interaction pattern (`IP-01…IP-14`), an accessibility requirement (`AX-01…AX-28`), a copy template (`C-01…C-25`) or a requirement/story (`R-###`, `US-###`). Nothing here invents a product requirement. Where a visual decision has no upstream id (a radius, a duration), it is labelled **design judgement** and justified in one line.

### 0.2 Vocabulary

The canonical vocabulary of UX §0.2 is used verbatim and is not redefined here: **Video**, **Batch**, **Stage** (`T RS SC SB IM NA TC RE QC`, plus the gate `FA` and the export stage `EX`), **Gate**, **Invalidated/stale**, **Pin**, **Call**, **Attention**, **Reuse**. Two additions are purely typographic and introduce no new product concept:

- **Signal** — one of the three channels a state is communicated through: colour, glyph, word. (A fourth, structure — border pattern — is used for the four problem states.)
- **Token** — a named CSS custom property. Tokens are named semantically (`--stale`, `--surface-raised`), never by appearance (`--purple`).

### 0.3 Hard constraints honoured in every screen

| Constraint | Where it is enforced visually | Source |
|---|---|---|
| No currency, credits, cost totals, estimates, caps or ledgers | No token is money-shaped; the only quantities in a warning are call counts and asset counts; the words "cost", "credit", "price", "budget" never label a number | D2, UX §0.3.2, IP-08 |
| No publishing, scheduling, account surfaces | No publish/post/connect/schedule/register/reset/invite/user-menu element exists in the component inventory | D3, D8, D9, R-015-3 |
| Stale is first-class and never auto-clears | `--stale` is its own hue with its own hatch and dashed border; the rail ribbon and tile badges persist until a re-run or an explicit accept | R-006-1, AX-13, DI-05 |
| Destructive and spend actions never look safe | Filled red `--danger-fill` for destructive; filled blue `--accent-fill` only for the single primary commit; spend-incurring buttons always sit second in tab order and never carry the same treatment as the no-spend commit | IP-01, IP-14, AX-04 |
| Failures are normal, not exceptional | Every failure surface uses the same six-part shape (what failed, stage, class, attempts, what survived, next action) and the same danger tokens; there is no generic "error" style | AX-25, IP-06 |
| Empty/first-run looks intentional | `UC-24` empty-state block: one sentence, one action, one quiet line — never a grid of zeros or a disabled fake dashboard | UX §6.2 |
| One generic caption safe area per aspect ratio | The render preview draws exactly one inset rectangle (5% = 54 px L/R, 96 px T/B at 1080×1920); there is no platform selector and no overlay switcher | D13, R-010-6 |

### 0.4 Design decisions taken in this document

1. **Dark only, no light theme.** Justified in §1.2. Tokens are semantic, so a light mapping can be added later without touching a component.
2. **Base type 14 px, table type 13 px.** The screen is a workbench read at 60–80 cm, not a marketing page read at 30 cm; 14 px keeps a 17-scene grid and a 30-row table on one 1440×900 viewport without scrolling in the review case.
3. **Three-signal state encoding, plus a structural fourth for problem states.** Colour alone never carries a state (AX-13). §3 defines glyph + word + border pattern for all eight states.
4. **Stale is violet, blocked is amber, failed is red.** Stale must not read as "error" (it is a normal consequence of an edit) and must not read as "warning" (which is the system's voice for degradation). §3.3 states the differentiation rule.
5. **Impact panel is inline and permanent, never a modal** (DI-02). It occupies the right 360 px column of the four edit tabs and is sticky within them.
6. **No animation touches an image.** No Ken Burns in previews without explicit play, no thumbnail cross-fades, no shimmer skeletons inside thumbnails. Motion is limited to state chips, panel reveals, focus and overlays (§2.7).
7. **No webfont, no icon package.** System UI stack + 21 hand-drawn inline SVG symbols on a 16 px grid. The container serves from a NAS over LAN; a 0–60 KB font or a 200 KB icon bundle buys nothing here.

---

## 1. Visual direction

### 1.1 What the product looks like

A dark, dense production console. Charcoal surfaces with one raised step per layer, hairline dividers, monospaced identifiers and counts, and colour reserved almost entirely for **state**. Images are the brightest thing on screen at all times: no chrome competes with a thumbnail, and no accent fills more than one control per region.

Three rules generate the layout:

1. **Attention at the top.** Groups are ordered `Needs attention → Running → Not started → Complete` (IP-05). Colour appears where the operator's work is.
2. **Numbers before prose.** Every warning leads with a count and an asset name, set in tabular monospace so digits align down a column and can be compared without reading.
3. **Two commits, never one.** Editing and spending are visually separate objects in separate places, with the no-spend commit first in reading and tab order (IP-01, DI-03).

### 1.2 Why dark, and why only dark

The operator reviews 17 images and a 1080×1920 render, late, in a single session (M2/M3; UX §1.1). Three reasons decide it:

- **Images are the subject.** On a light shell, a dark, low-key generated image reads as underexposed because simultaneous contrast pushes it darker than it is. On a `#0E1014` field the image is the only bright object, so what the operator judges is the image, not the surround. This is the product's core judgement and it is worth more than any brand consideration.
- **Glare at 23:00.** A near-black shell at low screen brightness reduces emitted light for the same perceived contrast; the tokens here are tuned for a dim room (text-primary is 14.88:1 on the panel, so brightness can be turned down without losing legibility).
- **One theme, honestly maintained.** A light theme would double the token audit surface (52 pairs become 104) and the four tint pairs are where a light theme usually breaks. The product is single-operator and LAN-only; a theme switch is not a requirement anywhere in the PRD.

If a light theme is ever demanded, the semantic token names are the migration path: only the 20 value declarations in §2.1 change, no component does.

### 1.3 What it must never look like

No glassmorphism, no gradients used as decoration, no rounded-pill everything, no drop-shadowed cards floating on a lighter page, no icon-only primary actions, no celebratory animation, no empty-state illustration of a robot. The mockup artifact is the reference; when in doubt, remove a border, then a shadow, then a colour.

---

## 2. Design system

### 2.1 Colour tokens

Semantic names first; hex is the value of the dark theme, not the identity of the token. Ratios in the last column are **measured** by `tools/contrast_audit.py` against `--surface-panel` `#15181E` unless stated (WCAG 2.2 relative luminance, sRGB).

**Surfaces**

| Token | Hex | Role | Rule |
|---|---|---|---|
| `--surface-app` | `#0E1014` | Page background, group-header rows, the field behind the frame | The darkest large area. Nothing but text and images sits directly on it except table group headers. |
| `--surface-panel` | `#15181E` | Default container: cards, panels, table body, rail | One step above app. Every bordered container uses this. |
| `--surface-raised` | `#1C2027` | Header bars inside a panel, sticky table head, dialog surface, toast | Only ever *inside* a panel or above the page as an overlay. |
| `--surface-inset` | `#0A0C10` | Inputs, textareas, code/values, "not started" thumbnails | Recessed: darker than the panel it sits in, 1 px `--border-default` outline. |
| `--surface-hover` | `#22272F` | Row hover, button hover (secondary) | Never the only change on hover — the pointer cursor and border also change. |
| `--surface-selected` | `#263041` | Selected row/tile, current nav item, "you are here" rail node | Always paired with a 2 px accent edge or an accent outline. Never used for "done". |
| `--surface-inverse` | `#E8EBF0` | The login submit's pressed state only (inverse flash) | Ratio to `--text-inverse`: 16.27:1. Used once in the product. |

**Tints** (state-bearing backgrounds; body text on each stays ≥ 12.4:1)

| Token | Hex | Role |
|---|---|---|
| `--surface-stale-tint` | `#2A2340` | Stale ribbon background, stale impact-panel group |
| `--surface-danger-tint` | `#33201F` | Failed tile and failure panel background |
| `--surface-warning-tint` | `#302614` | Blocked tile, degraded banner background |
| `--surface-success-tint` | `#13251A` | Reserved: QC pass block in S-15 only |

**Text**

| Token | Hex | Role | Ratio on panel | Threshold |
|---|---|---|---|---|
| `--text-primary` | `#E8EBF0` | Body, table cell, title, value | **14.88:1** | ≥4.5 (body) |
| `--text-secondary` | `#AEB7C4` | Secondary body, attention reason, helper copy | **8.78:1** | ≥4.5 |
| `--text-tertiary` | `#8B95A3` | Metadata, pins, timestamps, column headers, hints | **5.86:1** | ≥4.5 at 12 px |
| `--text-disabled` | `#5F6875` | Disabled label, disabled icon | **3.15:1** | exempt (WCAG 1.4.3 disabled-controls exception) — but never the *only* carrier of a reason: the reason is adjacent text |
| `--text-link` | `#9DBBF9` | Inline links ("see attempt rows") | **9.24:1** | ≥4.5 |
| `--text-inverse` | `#0B0D11` | Label on a light fill | 16.27:1 on `--surface-inverse` | ≥4.5 |

**State colours** (each is a *text* colour at ≥4.5 and a *boundary* at ≥3.0)

| Token | Hex | Ratio on panel | Meaning |
|---|---|---|---|
| `--accent` | `#7EA6F8` | **7.36:1** | Focus, current position, "awaiting approval" |
| `--success` | `#4CC26A` | **7.82:1** | Done, QC pass, integrity ok |
| `--warning` | `#E3A639` | **8.28:1** | Blocked, degraded, "expected, not an error" |
| `--danger` | `#FF7B72` | **7.05:1** | Failed, destructive confirmation, broken integrity |
| `--stale` | `#BBA1FF` | **8.17:1** | Invalidated by an edit — stored, downloadable, out of date |
| `--running` | `#4FD1E0` | **9.76:1** | A provider or local job is executing now |
| `--cancelled` | `#8B95A3` | **5.86:1** | Cancelled or deliberately skipped |

**Borders and fills**

| Token | Hex | Role | Ratio |
|---|---|---|---|
| `--border-subtle` | `#272D37` | Hairline divider, table grid, card edge | 1.28:1 — **decorative only**, never the sole boundary of an interactive control (WCAG 1.4.11 exemption is not claimed: controls use `--border-default`) |
| `--border-default` | `#6B7480` | Every interactive boundary: input, select, secondary button, tile | **3.75:1** on panel, 4.02:1 on app |
| `--border-strong` | `#8B95A3` | Hover boundary, dialog edge, table head rule in dialogs | **5.86:1** |
| `--accent-fill` | `#2F5FD0` | Primary button background | 3.11:1 vs panel; label `#FFFFFF` **5.72:1** |
| `--accent-fill-hover` | `#3A6CE0` | Primary button hover | label `#FFFFFF` **4.77:1** |
| `--danger-fill` | `#C62828` | Destructive button background | 3.16:1 vs panel; label `#FFFFFF` **5.62:1** |
| `--danger-fill-hover` | `#D13A2A` | Destructive hover | label `#FFFFFF` **4.83:1** |
| `--control-fill` | `#22272F` | Secondary button background | label `--text-primary` **12.56:1** |

**Rules that constrain colour use**

1. Filled colour (`--accent-fill`, `--danger-fill`) is allowed on **at most one control per region**. A panel has one primary action; a dialog has one primary and one destructive, never both filled at the same size in the same corner.
2. `--danger` never appears as a decoration, an icon colour for anything but a real failure or a destructive action, or in a chart (there are no charts).
3. `--stale` is never used for a system warning and `--warning` is never used for staleness. See §3.3.
4. The `--success` colour never appears on a "completed" batch row's background; only on its chip, its QC checks and its progress bar. A wall of green competes with the images.
5. `--text-tertiary` is never used for a number the operator must compare; those use `--text-secondary` or `--text-primary` in tabular figures.

### 2.2 Surfaces, elevation and borders

| Level | Token | Geometry | Use |
|---|---|---|---|
| e-0 | none | 1 px `--border-subtle`, `--r-3` | Default card/panel. In dark UI the border *is* the elevation. |
| e-1 | `0 1px 2px rgba(0,0,0,.45)` | 1 px border | Sticky header over scrolling content, popover head |
| e-2 | `0 4px 12px rgba(0,0,0,.50)` | 1 px `--border-default` | Dropdown, toast |
| e-3 | `0 12px 32px rgba(0,0,0,.62)` | 1 px `--border-default`, `--r-4` | Dialog, the 1440 screen frame in the mockup artifact |

Shadow is only used for things that float **above** the page (dialog, toast, dropdown). A panel on the page uses a surface step and a border; adding a shadow to it is a defect.

Border widths: `1px` structural; `2px` focus outline and the selected-item edge; `3px` the failed row's left bar and the blocked chip's double border; `4px` the failed tile's left bar. No other widths exist.

### 2.3 Type scale

System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`. Mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`. No webfont is downloaded; the NAS serves no font files.

| Token | Size / line | Weight | Tracking | Intended use |
|---|---|---|---|---|
| `--t-80` | 32 / 40 | 600 | 0 | Login wordmark only. Nothing else in the product is this size. |
| `--t-70` | 24 / 32 | 600 | 0 | Page title (`Batch 2026-10-20-a`, `Script`, `Health`) |
| `--t-60` | 20 / 28 | 600 | 0 | Section title inside a panel (`Change impact`, `Claims`) |
| `--t-50` | 16 / 24 | 600 | 0 | Workspace title (video title), subsection heading |
| `--t-40` | 14 / 22 | 400/600 | 0 | Body, editor text, button label at large size, menu item |
| `--t-30` | 13 / 20 | 400/600 | 0 | Dense body: table cells, impact-panel list items, callouts, buttons |
| `--t-20` | 12 / 18 | 400/600 | 0 | Metadata: ids, pins, timestamps, helper text, counts in a row |
| `--t-10` | 11 / 16 | 600 | .08em, uppercase | Column headers, state chip text, section eyebrows, "gate" tag |

Rules:
- **Numbers are always `font-variant-numeric: tabular-nums`.** Every count, duration, percentage, byte size, word count and pin. Mono is used for identifiers (`S07`, `req_8f21`, `v13`), never for prose.
- Only three weights exist: 400, 600, 700 (700 is reserved for state chips and row ids). No 300, no 500, no 800.
- Line length: editor text max `68ch`; error and warning copy max `92ch`. Longer strings wrap into a list, they do not run across a 1440 panel.
- The page never uses a font size below 11 px. Anything that would need 10 px is moved to a `.label` or dropped.

### 2.4 Spacing scale

4 px base, eight steps in use plus two large paddings:

| Token | px | Use |
|---|---|---|
| `--s-1` | 2 | Chip inner vertical padding, icon-to-text gap in a chip |
| `--s-2` | 4 | Baseline nudge, list-item gap, chip horizontal padding |
| `--s-3` | 6 | Tile meta padding, tight icon gap |
| `--s-4` | 8 | Button-to-button gap, field label-to-input gap, table cell horizontal padding |
| `--s-5` | 12 | Card inner gap, table cell padding, chip grid gap |
| `--s-6` | 16 | Panel padding (compact), grid gap between tiles, dialog padding |
| `--s-7` | 20 | — (reserved) |
| `--s-8` | 24 | Page padding, column gap between editor and impact panel, section gap |
| `--s-9` | 32 | Section separation on a long screen |
| `--s-10` | 40 | Above a page title |
| `--s-11` | 48 | Rail width of the "walk the queue" control group |
| `--s-12` | 64 | Login card top offset |

No arbitrary values: if a gap is needed, it is one of these. Component-internal alignment that must be pixel-exact (icon centring) uses flex centring, not a magic number.

### 2.5 Radii

| Token | px | Use |
|---|---|---|
| `--r-1` | 2 | State chip, badge, inline `code`, pin tag |
| `--r-2` | 4 | Input, select, button, checkbox |
| `--r-3` | 6 | Panel, card, tile, callout, toast |
| `--r-4` | 10 | Dialog only |
| `--r-full` | 999 | Avatar-less; used only for the nav attention badge and the status dot |

Images are never rounded on the inside of a tile: the tile clips them at `--r-3`, so the 9:16 frame keeps true corners for judging composition.

### 2.6 Iconography

21 symbols, hand-drawn, inline SVG, 16×16 viewBox, `stroke-width: 1.6`, round caps and joins, no fills except where a dot or play triangle needs one. Defined once as `<symbol>` in `mockups/ui-mockup.html` and inlined by the app's build; **no icon package is installed**.

| Glyph | Name | Used for |
|---|---|---|
| ✓ | `check` | done, integrity ok, QC pass, apply-edit |
| ✕ | `x` | failed, dismiss, destructive |
| ◷ | `clock` | waiting, last-update age |
| ◌ (arc) | `spinner` | running (2 px stroke, rotates only under `prefers-reduced-motion: no-preference`) |
| 🔒 (lock) | `lock` | gate, awaiting approval, "required" gate |
| ⚠ | `warn` | stale, degraded, unknown charge |
| ⊘ | `ban` | blocked (rate limit, render slot, citations) |
| ╱ | `slash` | cancelled |
| • | `dot` | not run |
| ▶ | `play` | audio/video play (S-14, S-15) |
| ▣ | `img` | image/replace/release |
| → | `arrow` | "next needing attention", inline forward link |
| › | `chev` | row open, breadcrumb separator |
| ↓ | `dl` | download/export |
| ↻ | `retry` | retry, regenerate |
| ↑ ↓ | `up`/`down` | reorder (Alt+↑/↓), also the video previous/next pair |
| ⠿ | `drag` | drag handle (reorder, posting order) |
| ⌕ | `search` | search/filter |
| i | `info` | informational callout |
| ⤴ | `ext` | "see attempt rows", external link |

Sizes: **12 px** inside a chip; **16 px** default (button with label, table action, tile corner); **20 px** in callout headers, banners, nav; **24 px** in empty states and the audio transport. An icon-only button is 32×32 (or 44×44 if it is a primary review control), always has an `aria-label`, and always has a visible tooltip after 400 ms — except where the icon is inside a labelled control, in which case it is `aria-hidden="true"`.

### 2.7 Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `--dur-1` | 80 ms | `cubic-bezier(.2,0,0,1)` | Hover, focus, chip colour/border change |
| `--dur-2` | 140 ms | `cubic-bezier(.2,0,0,1)` | State chip swap, row selected, tab underline |
| `--dur-3` | 220 ms | `cubic-bezier(0,0,0,1)` enter / `cubic-bezier(.4,0,1,1)` exit | Impact panel expand/collapse to ribbon, banner appear |
| `--dur-4` | 320 ms | `cubic-bezier(.2,0,0,1)` | Dialog enter (opacity + 4 px rise); toast enter (opacity + 8 px slide) |
| — | 1.2 s | `linear` | Spinner rotation. The **only** loop in the product. |
| — | 700 ms | `linear` | Determinate progress-bar width. Per-region only, 2 px tall. |

Permitted animated properties: `opacity`, `transform`, `background-color`, `border-color`, `outline-color`, `width` of a progress bar. **Forbidden:** any animation of an `<img>` or `<video>`, thumbnail cross-fades, skeleton shimmer inside thumbnails, layout-shifting reveals, parallax, and any motion that repeats attention away from an image.

`prefers-reduced-motion: reduce` sets every duration above to `0.01 ms`, stops the spinner (the chip keeps its word `running` and a static ◌), and disables progress-bar width animation (the value jumps). This satisfies AX-16.

### 2.8 Focus and interaction tokens

```
--focus-ring-width: 2px;
--focus-ring-color: #7EA6F8;      /* 7.36:1 on panel, 5.50:1 on selected row */
--focus-ring-offset: 2px;
--focus-ring-style: solid;
```

Focus is drawn with `outline`, not `box-shadow`, so it survives `overflow: hidden` on tiles and table rows and is visible on top of any tinted background. Focus ring is never removed — `:focus-visible` only decides *when* it is painted for pointer users. On a selected row the ring is inset by 1 px so it is not clipped by the table edge (`outline-offset: -1px` inside `.tbl tbody tr`).

Target sizes: every pointer target is ≥ 24×24 CSS px (AX-17 floor); every gate, replace, retry, release, export and download control is ≥ 44×44 with ≥ 8 px separation from its neighbour. A 32 px icon button that must sit in a dense row is padded to a 24 px hit area minimum and is never adjacent to another icon button without an 8 px gap.

## 3. Semantic state palette

The eight states of UX §7 (`not run`, `running`, `done`, `awaiting approval`, `stale`, `failed`, `blocked`, `cancelled`) are the product's core visual grammar. Each is encoded on **four** channels — colour, glyph, word, structure — so it survives greyscale, colour-blindness, a 200% zoom and a screenshot pasted into a chat (AX-13).

### 3.1 The table

| State | Colour token / hex | Glyph | Label (exact string) | Chip treatment (structure) | Row / tile treatment | Used in |
|---|---|---|---|---|---|---|
| `not run` | `--text-tertiary` `#8B95A3` (5.86:1) | • `dot` | `NOT RUN` | transparent bg, 1 px solid border, `--r-1`, 11 px uppercase | Tile: `--surface-inset` thumb + centred 24 px image glyph at 50% opacity. Rail: dim code, no pin. | Rail nodes before their stage starts (SB…QC on a fresh video); scene tiles not yet generated |
| `running` | `--running` `#4FD1E0` (9.76:1) | ◌ `spinner` | `RUNNING` | `rgba(79,209,224,.08)` bg, 1 px solid border | Rail node: 2 px determinate bar along its bottom edge (`IM 11 of 17`). Row: no fill, chip only. | IM during generation, NA during TTS, RE during render, QC during checks |
| `done` | `--success` `#4CC26A` (7.82:1) | ✓ `check` | `DONE` | `rgba(76,194,106,.10)` bg, 1 px solid border | No row fill. Rail node shows its pin. | Completed producing stages; QC pass items; integrity checks |
| `awaiting approval` | `--accent` `#7EA6F8` (7.36:1) | 🔒 `lock` | `AWAITING APPROVAL` (rail: `AWAITING`) | `rgba(126,166,248,.10)` bg, 1 px solid border **+ 3 px right border** ("gate notch") | Row is grouped at the top; no fill. Rail node gets `--surface-selected` + 2 px accent bottom edge when it is "you are here". | SC (script gate), IM (first-three checkpoint review), FA (final gate) |
| `stale` | `--stale` `#BBA1FF` (8.17:1) | ⚠ `warn` | `STALE` | **dashed** 1 px border + 135° 2 px hatch of `rgba(187,161,255,.14)` | Tile: dashed border + hatch overlay on the thumb (image still fully visible, hatch at 14% over it). Rail node: hatch background + ⚠ before the word. | Rail NA/TC/RE after a script edit; scene tiles after a prompt/replace edit; stale ribbon |
| `failed` | `--danger` `#FF7B72` (7.05:1) | ✕ `x` | `FAILED` | `--surface-danger-tint` bg, 1 px solid border **+ 4 px left bar** | Row: 3 px inset left bar in `--danger`; state cell chip. Tile: red border, tint, `attempt 3/3` in the thumb. | NA/IM/RE failures, S-15 render failure, tile-level failure |
| `blocked` | `--warning` `#E3A639` (8.28:1) | ⊘ `ban` | `BLOCKED` | `--surface-warning-tint` bg, **3 px double** border | Row: 3 px inset left bar in `--warning`. Tile: amber border + tint. Rail: amber code. | `IM`/`NA` before script approval, `EX` before final approval, provider down, rate limit, render slot, unsourced claims |
| `cancelled` | `--cancelled` `#8B95A3` (5.86:1) | ╱ `slash` | `CANCELLED` | transparent bg, 1 px solid border, **line-through on the word** | Row: 60% opacity on the title only, never on the state chip. Batches cancelled per IP-14. | Videos in a cancelled batch; discarded draft topic |

**Chip sizes.** `sm` 20 px tall / 11 px text (table rows, rail) — default. `md` 24 px / 12 px sentence case (panel headers, tile corners) — used where the chip is the only state word in a region. `lg` 28 px / 12 px sentence case with a 14 px glyph — only in the workspace header (`awaiting script approval`) and in a dialog title. There is no `xs`; a state that needs less than 20 px does not get a chip.

### 3.2 Why the structure channel exists

At 100% zoom a chip is legible. At 200% zoom inside a 30-row table, at 1024 px, and in a greyscale screenshot, chips shrink to words with similar silhouettes. The structural signal is the invariant:

| State | Border | Silhouette at a glance |
|---|---|---|
| not run | thin solid | flat bar |
| running | thin solid + moving 2 px bar | bar with movement (the only moving thing in a row) |
| done | thin solid | flat bar |
| awaiting approval | 3 px right edge | **notched on the right** |
| stale | dashed + hatch | **textured** |
| failed | 4 px left edge + tint | **heavy left edge** |
| blocked | 3 px double | **double line** |
| cancelled | thin solid + strike | **struck word** |

No two states share a silhouette. This is the test QA can run: desaturate a screenshot of S-08 and the stage rail and identify all eight without colour. `not run` and `cancelled` deliberately share the neutral grey — neither is a problem state — and are separated by the strike-through, the glyph (• vs ╱) and the word; a cancelled row is never merely "greyed out".

### 3.3 stale vs warning vs failed vs blocked — the rule

These four are the most likely to be confused, so the rule is explicit and appears in the component spec for every one of them:

- **failed** — the system attempted the work and could not finish it. Red, heavy left edge, and the surface always offers *what a retry re-runs*. A failure is an event that already happened.
- **blocked** — the system has **not** attempted the work because a precondition is unmet: a gate is closed, a provider is down, a rate limit is hit, a render slot is busy, claims are unresolved. Amber, double border, and the surface always names the *precondition* and the *operator action that clears it*. Nothing was spent.
- **stale** — the artefact **exists, is stored, is downloadable and is usable**; an edit has made it out of date. Violet, dashed + hatched, and the surface always names *which edit and revision* made it stale plus what survives. It is not an error, and it never clears itself.
- **warning (token)** — the system's own voice about degradation (disk, DB, provider health). It appears only in banners and callouts, never as a chip. A `blocked` chip reuses the amber hue; the ⊘ glyph and the word `BLOCKED` keep them apart, and a banner always carries a full sentence with a cause.

Consequence for the palette: `--warning` and `--stale` are deliberately far apart in hue **and** in lightness (8.28:1 vs 8.17:1 is not the differentiator — violet vs amber is, and dash/hatch vs double is). A colour-blind operator sees violet as mid-grey and amber as light yellow, and still has ⚠/⊘, `STALE`/`BLOCKED`, and dashed/double.

### 3.4 Attention reasons

The attention reason is text, in `--text-secondary`, never a chip — the state column already carries the chip, and a second chip would double-encode. Format is `category: detail`, exactly the vocabulary of UX IP-05:

| Reason string | Rendered with | Meaning |
|---|---|---|
| `script approval` | 🔒 accent glyph, then text + revision (`rev 4`) | SC gate open (mandatory) |
| `image review` | 🔒 accent glyph, then `3 of 17 generated` | First-three checkpoint reached (PRD §10) |
| `final approval` | 🔒 accent glyph | FA gate open (mandatory) |
| `failed: narration` | ✕ danger glyph | Stage-level failure; links to retry scope |
| `blocked: 3 unsourced claims` | ⊘ warning glyph | Factual-mode citation block |
| `blocked: duplicate topic` | ⊘ warning glyph | Dedupe rejection, override available |
| `waiting: render slot` | ◷ clock glyph, `--text-tertiary` | Benign queue state, not an error |
| `waiting: rate limit` | ◷ clock glyph, `--text-tertiary` | Benign, expected (R-008-2) |
| `resumed after restart` | ↻ running glyph | R-023-1 resumption, informational |

`waiting: render slot` and `waiting: rate limit` are **never** coloured as errors and never sorted into "Needs attention" — they sit in `Running` (IP-05). Only the first six count toward the attention badge.

---

## 4. Layout system

### 4.1 The shell

| Region | Size | Notes |
|---|---|---|
| Top status strip | 40 px, full width, sticky | Service state, degraded chips, in-flight count, operator id. Always visible; never hides degradation behind a hover (IP-07). |
| Left rail | 216 px expanded (`≥1440`); 64 px compact (`1024–1439`) | Overview · Series · Batches · Posting · Health, then Settings pinned to the bottom. Active item: `--surface-selected` + 2 px accent left edge. |
| Content | fluid, max 1600 px, padding 24 px | Page title 24/32 with a 20 px breadcrumb above it. |
| Workspace right column | 360 px fixed (`≥1440`), 320 px (`1024–1439`), stacked (`<1024`) | The change-impact panel (UC-06). Gap 24 px. |
| Footer (workspace) | 32 px, sticky bottom | Pins, mode, calls used. Always present on S-09…S-16 (R-002-4). |

Z-index scale — fixed, no invented values: `0` content, `10` sticky table head, `20` global banner, `30` dropdown/popover, `40` dialog + scrim, `50` toast.

### 4.2 Vertical rhythm

- Page padding-top 24, title block 20 + 32, section gap 32.
- Panel padding 16 (compact) / 20 (default). There is no 24 px panel padding below 1024.
- Table: header 28 px, row 44 px, group header 32 px. Nothing else in a table may change height.
- Rail: 56 px tall, nodes 74 px min width, 1 px dividers, 11 equal nodes at ≥1024. Below 1024 the rail scrolls horizontally inside its own container (never the page).

### 4.3 Form layout

Two columns at ≥1024: label column 160 px, control column `min(420px, 100%)`, 16 px gap, fields stacked 20 px apart. At <1024 the label sits above the control. Helper text is 12 px `--text-tertiary` below the control with a 4 px gap; error text replaces the helper in `--danger` with a ⚠ glyph and is wired with `aria-describedby` (AX-11).

### 4.4 Density rules

| Surface | Row / tile | Why |
|---|---|---|
| Batch table (S-08, S-17, S-18, S-19 attempt rows) | 44 px | 30 rows + header + 4 group headers ≈ 1,500 px; scrolls, but three groups are visible on one 900 px viewport with the header |
| Scene grid (S-12) | 168 px tile, 9:16 thumb 168×298, meta 32 px, gap 12 | 6 per row at 1440 (1,068 px of 1,176 available); 17 scenes = 3 rows |
| Claims table (S-10) | 56 px | Claim text wraps to 2 lines; this is a reading surface, not a scanning one |
| Attempt rows (S-19) | 36 px | Debug list, monospaced, 50 per page |
| Rail | 56 px | 11 nodes across 1,176 px = 106 px each at 1440 |

---

## 5. Components

24 components. Each entry states purpose and trace, anatomy, variants, sizes, states, behaviour/keyboard, and the anti-pattern it exists to prevent. Complexity flags (`CSS-only`, `JS behaviour`, `JS + server data`) are repeated in the CTO inventory in §10.1.

### UC-01 — App shell (top strip + left rail)

**Trace.** S-02…S-21 shell; UX §2.2; IP-07; R-018-1; AX-27.
**Anatomy.** (1) Top strip 40 px: service-state dot 8 px + word (`Service ready` / `DEGRADED`), in-flight count, attention count (only on Overview, as a number badge `4`), operator id in mono. (2) Left rail 216/64 px: five destinations, Settings at the bottom, attention badge on Overview only (J-1: "the only global counter"). (3) Breadcrumb 20 px. (4) Content region.
**Variants.** Expanded (≥1440) / compact (1024–1439, icon + 3-letter label, accessible name = full label) / hidden (<768, replaced by a top bar with a back link, because the phone view is monitoring-only).
**States.** Ready (green dot, no fill); degraded (amber dot + one-line cause, clickable to S-19); not ready (red dot, `Service not ready`); loading (dot pulsing is **not** used — the dot holds its last known colour and the strip shows `checking…` in `--text-tertiary`).
**Keyboard.** First focusable is the rail's first item; `Skip to content` link is the very first tab stop on every page (visually hidden until focused). Rail items are links, not buttons; `aria-current="page"` on the active one.
**Do not.** Do not make the badge an action; it is a count. Do not collapse degradation into an icon-only dot — IP-07 requires words.

### UC-02 — Breadcrumb and workspace tabs

**Trace.** UX §2.2, W-04; S-09…S-16.
**Anatomy.** Breadcrumb `Overview / Quiet Mind / batch 2026-10-20-a / video 7 of 30` at 12 px mono, separators `›` in `--text-tertiary`, current segment in `--text-secondary`, previous segments are links. Tabs 34 px tall: `Topic · Script · Storyboard · Scenes · Audio · Render · Export`.
**States.** Default (`--text-secondary`), hover (`--surface-hover` + `--text-primary`), selected (`--text-primary`, 600, 2 px accent bottom edge), disabled (none — a tab is never disabled; it shows its own honest empty/blocked state, per UX §6.2).
**Keyboard.** `←`/`→` move between tabs (roving tabindex, `role="tablist"`); `Home`/`End` jump; the panel is `role="tabpanel"` with `aria-labelledby`. The rail (UC-03) is **not** a tablist — it is a status list with links, so it uses plain links and does not steal arrow keys.
**Do not.** Do not grey out a tab because a stage has not run; the tab explains why inside.

### UC-03 — Stage rail (11 nodes)

**Trace.** IP-03, W-04, UX §0.2 stage codes; R-002-4; AX-13.
**Anatomy.** One row, 56 px tall, 11 nodes (`T RS SC SB IM NA TC RE QC FA EX`), each: code (12 px mono, 700), state word (11 px uppercase), pin (11 px mono `v13`, only when the stage has produced something). Node min width 74 px, `flex: 1 1 0`, 1 px `--border-subtle` dividers. `FA` and `EX` carry a permanent `gate` tag (9 px, outlined) because FA is a gate, not a producing stage.
**Variants.** Full (11 nodes, ≥1024). Compact (<1024): nodes become 44 px wide with code + a 12 px state glyph, the state word moves into the tooltip and the accessible name; the rail scrolls horizontally rather than wrapping. Stale variant: three or more consecutive stale nodes get one merged ribbon beneath the rail (UC-05) instead of 3 separate tooltips.
**States.** The eight of §3, plus `current` (`--surface-selected` + 2 px accent bottom edge + `aria-current="step"`), plus `running` with a determinate 2 px bar at the node's bottom edge (`IM 11 of 17`).
**Behaviour.** Clicking a node navigates to that stage's tab if it exists; `FA` opens the approval control, `EX` the export tab. Hovering a node shows a 400 ms tooltip: `<code> · <state> · <pin> · <last event>`; for stale nodes the tooltip is mandatory and names the cause (`stale: script rev 4, 14:12 UTC`). A stale node is never auto-cleared (IP-01).
**Keyboard.** `g` then the stage letter jumps (`g s` → Script, `g i` → Images, `g f` → Final). The rail is one tab stop with `←`/`→` between nodes (roving tabindex), not eleven tab stops — eleven tab stops before content is a keyboard tax.
**Do not.** Do not use a progress bar for a whole stage (a stage is not 40% done; it is running, with `11 of 17` scenes). Do not colour the whole rail node red on failure — the chip word and the glyph do the work; the node only tints at 8% and carries the left bar in the *table*, not the rail.

### UC-04 — Video state chip

**Trace.** §3; IP-03, IP-05; AX-13; used in tables, tiles, headers.
**Anatomy.** 20/24/28 px tall, `--r-1`, 1 px border, 6 px horizontal padding, 12 px glyph, 11 px uppercase 700 text with .06em tracking (sizes `md`/`lg` use 12 px sentence case, 600).
**Variants.** Eight states × three sizes. `with-glyph` (default) and `text-only` (allowed only inside a table cell that already has the glyph in the attention column — never in the rail).
**States.** Static only; the chip does not animate except a 80 ms colour transition on change. When a chip's state changes, the chip is replaced, not cross-faded, and the change is announced once through UC-23's live region (AX-07/AX-10).
**Do not.** Do not use the chip's colour as the only sign of the state (AX-13), and do not invent a ninth state (`paused`, `retrying`, `queued` are all `blocked` or `running` with an attention reason, per UX §0.2).

### UC-05 — Stale ribbon

**Trace.** IP-01 "persistence after commit", DI-05; R-006-1; W-04 `stale:` line.
**Anatomy.** A 28 px strip directly beneath the stage rail, full content width: ⚠ 16 px in `--stale` + `NA ⚠ stale · TC ⚠ stale · RE ⚠ stale` in 12 px mono + a right-aligned quiet action `Accept staleness` and a link `Why?`.
**Variants.** (a) Rail ribbon (3+ nodes); (b) node-level tooltip (1–2 nodes); (c) in-panel group inside UC-06 (`Becomes stale` list); (d) tile badge (UC-08). All four use `--stale`, dashed, ⚠ and the word.
**States.** Visible (default), hover (tooltip with cause and revision), dismissed — **not a state**: staleness is never dismissible; `Accept staleness` is an explicit, recorded act that changes the stage's state from `stale` to `done` with an acknowledgement note, and it is a two-step confirmation naming what is being accepted.
**Content.** Exactly `stale: <cause>, <revision>, <HH:MM UTC>` in the tooltip; `stale` in the chip. Never "outdated" or "needs refresh" — one word per state (AX-20).
**Do not.** Do not clear on navigation, refresh, worker restart or a successful unrelated stage. Do not make it red.

### UC-06 — Change-impact panel (IP-01)

**Trace.** IP-01, W-05, W-07; R-006-1/2/3; DI-02; C-01…C-07; AX-04.
**Anatomy (exact, top to bottom).** Header 40 px: label `Change impact` + state chip on the right (`4 stale` / `computing` / `no assets`). Body 16 px padding, four groups in fixed order: (1) **What changes** — one sentence naming field + revision (`Script rev 4 → rev 5 · wording only`). (2) **Becomes stale** — `Warning` label in `--stale`, then a bulleted list with bullets in `--stale`, each item `stage (quantity)` in 13 px, e.g. `narration (1 TTS call)`. (3) **Survives** — `Success` label, bullets in `--success`, e.g. `17 stored images (v13)`. (4) **Calls if regenerated** — inset box, mono 12 px, `image calls: 0 · TTS calls: 1 / render passes: 1 · text: re-derive 17 prompts`. Footer 16 px padding, `--surface-raised`: two full-width 44 px buttons, *`Apply edit (no regeneration)`* (secondary, first, initial focus) then *`Apply and regenerate now`* (primary filled).
**Variants.** Ready; computing (skeleton rows, both buttons disabled, form still editable); failed (`C-07` copy + Retry, both buttons disabled); nothing-to-invalidate (`No assets exist yet — this edit costs nothing to apply.`, apply enabled, regenerate hidden); conditional aspect-ratio (`pending reframe check`, regenerate disabled with the exact two outcomes named); reorder (live strip while dragging: `moves scene 4 → 2; captions remap; 0 image, 0 TTS calls`).
**States.** Every control: default / hover / focus-visible / active / disabled. Panel: collapsed-to-ribbon after commit (220 ms), expanded, sticky (`position: sticky; top: 40px`) inside the tab scroll area.
**Keyboard.** Tab order is field → panel → *Apply edit* → *Apply and regenerate*. `Enter` on a focused *Apply edit* commits with no spend. The regenerate button never receives focus automatically and never responds to the `Enter` that committed an edit (AX-04). `Space`/`Enter` on regenerate requires focus to have moved there deliberately.
**Do not.** Do not put it in a modal, a toast or a popover (DI-02). Do not show a single number as "cost"; the four call types are listed separately and never summed (D2). Do not enable the regenerate button before the panel has rendered a complete preview (W-07).

### UC-07 — Scene grid

**Trace.** S-12, W-06; R-007-1/2; IP-04; DI-10.
**Anatomy.** Responsive grid of UC-08 tiles, `repeat(auto-fill, minmax(168px, 1fr))`, gap 12. Above it: a 40 px header with the stage chip (`awaiting image review`), `3 of 17 generated · 14 not started` in mono, and the checkpoint action. Below it: a 44 px selection bar (`selected: S03 · replace 1 image call · reorder 0 calls`) with the replace and reorder controls. The grid always renders **all** 17 tiles (empty ones explicitly `not started`) so the count is never ambiguous (W-06).
**Variants.** Awaiting first-three checkpoint (banner above the grid: `3 of 17 generated. Check the protagonist before releasing the remaining 14 (14 image calls).` + *Release remaining 14* / *Fix scenes 1–3 first*); full run (all tiles filling); no recurring protagonist (`Protagonist checkpoint not applicable — this series has no recurring character`); empty (0 of 17, all `not started`, stage `blocked: script not approved`).
**States per tile.** See UC-08. Grid-level: loading (tiles render immediately as `not run` and fill in — never a full-panel spinner, AX-28); partial (the normal state); error (a tile fails, the grid keeps working, the tile carries the retry scope); blocked (banner naming the precondition; tiles keep their last state).
**Keyboard.** `j`/`k` move selection (roving tabindex, selection follows focus), `Enter` opens S-13, `r` opens replace scope, `Alt+↑/↓` reorders, `Esc` clears. Selection is announced as `Scene 3 of 17, S03, ready, 3.1 seconds, pin v13`.
**Do not.** Do not add multi-select (every action is per scene, R-007-1). Do not hide not-started tiles. Do not lazy-load so aggressively that scene 17 is blank while 1–16 are visible — the count is the information.

### UC-08 — Scene tile

**Trace.** W-06; R-007-2, R-013-1; IP-04; AX-15, AX-17.
**Anatomy.** 168 px wide, `--r-3`, 1 px border, clipped. Thumb 9:16 (168×298), object-fit cover. Top-left: state chip (20 px). Top-right: pin tag (`v13`, 10 px mono, 14 px tall, `rgba(10,12,16,.72)` bg). Meta row 32 px: `S03` (12 px mono 700) left, narration span `3.1 s` (12 px mono, tertiary) right. No prompt text in the tile (density; prompts live in S-13).
**Variants.** ready, generating (thumb shows `11/17` in mono with the spinner chip), failed (red tint, `attempt 3/3`), stale (dashed + hatch), needs review, selected (2 px accent outline + `--surface-selected` meta row), not started (`--surface-inset` + 24 px image glyph at 50%).
**States.** Default / hover (border `--border-strong`, 80 ms — the image does **not** scale or brighten) / focus-visible (2 px outline offset 2, inside the clip) / selected / disabled — a tile is never disabled; if the stage is blocked the action inside S-13 is disabled with a reason.
**Accessibility.** The thumb `<img>` has `alt` = prompt summary (`Scene 3: protagonist at a rain-soaked window, low angle`) truncated at 140 chars, and the tile's accessible name is `Scene 3 of 17, S03, ready, 3.1 second narration, pin v13` (AX-15). The narration span is a `<span>` with an accessible full form (`3.1 seconds`).
**Do not.** Do not overlay captions or safe-area guides on the tile (D13 — the only safe-area rectangle is in the S-15 render preview). Do not animate the thumb.

### UC-09 — Scene compare and replace (dialog)

**Trace.** S-13; R-007-1, R-013-1/2; IP-04; IP-14 "regenerate over an approved stage"; OQ-2 default.
**Anatomy.** Modal 1,040×720 max (90vw/90vh), `--r-4`, e-3, padding 20. Left: current image 360×640 (9:16) with a 24 px label `current · attempt 2 of 3 · 14:12 UTC · prompt hash abc123`. Right 600 px: (a) side-by-side compare mode — two 240×426 images (`attempt 1` / `attempt 2`) with a 2 px vertical divider, no slider (a slider is a toy; two static frames are judgeable); (b) prompt block in 13 px mono, read-only with an *Edit prompt* action; (c) provenance table: model `gemini-nano-banana-2.1`, seed, request id, series pin `v13`, rights note; (d) the replace button `Replace image · 1 image call` (44 px, secondary) that opens the IP-01 panel scoped to this scene.
**Variants.** Compare (2 attempts), single (only one attempt exists), replace-scope (impact panel replaces the compare pane), prompt-edit (same as replace, per OQ-2: `1 image call`).
**States.** Loading (image skeleton with a fixed 360×640 box — no layout shift), error (image failed to load: box with `image unavailable` + retry), replace-running (the button becomes `Replacing… 1 image call` with a spinner; the dialog stays open and the new image appears in place), blocked (provider down: replace disabled with the reason from IP-07).
**Keyboard.** Esc closes without committing; focus trap; focus returns to the *Replace image* button on close; `←`/`→` flips compare attempts; the replace button is never the initial focus (initial focus is the dialog heading's close button area or the compare frame, per AX-04).
**Copy.** `Replacing scene 7's image costs 1 image call. Scene 7's visual and the render become stale. Images 1–6 and 8–17 and the narration survive.` (C-02, verbatim).

### UC-10 — Reorder strip

**Trace.** R-006-3, R-007-2/3; IP-04; AX-05; C-03.
**Anatomy.** A 56 px horizontal strip of 17 numbered blocks (32×40, `--surface-raised`, 12 px mono id) shown while a reorder is in progress; the dragged or keyboard-moved block is lifted (e-2) and its target gap is marked with a 2 px accent rule. Below it a single line: `captions remap to the new order · 0 image calls · 0 TTS calls · render stale`.
**Variants.** Drag (pointer) and keyboard (`Alt+↑/↓`); both produce identical results and identical announcement. Committed (strip disappears, the grid re-renders in new order, scene ids unchanged) and cancelled (Esc, original order restored with no commit).
**States.** Idle (hidden), dragging, over-target, committing, failed (commit rejected: `Order not saved — retry`, original order restored).
**Keyboard.** `Alt+↑/↓` moves the selected scene one position; announcement `S05 moved to position 3 of 17. Captions remap; 0 image calls, 0 TTS calls; render becomes stale.` `Esc` cancels. Focus stays on the moved scene's grid tile.
**Do not.** Do not renumber scenes (`S01…S17` are stable, R-007-2). Do not call a provider on commit — this component can never spend (R-006-3).

### UC-11 — Batch progress table

**Trace.** S-08, W-03; IP-05; R-019-3, R-021-1, R-022-1; AX-10, AX-27.
**Anatomy.** (1) Header 56 px: `18 of 30 complete · 3 need attention · 9 running · 1 failed` (counts in tabular figures, attention in accent, failed in danger) + `last update 2 s ago` right-aligned in 12 px mono + `Review next needing attention →` button + filter group `all | attention | failed`. (2) Table: columns `# 48 · Title fluid min 280 · Stage 96 · State 132 · Attention reason 260 · Pins 120 · Last event 96 · Actions 120`; header 28 px sticky; rows 44 px; group headers 32 px in fixed order `Needs attention → Running → Not started → Complete`. (3) Footer 40 px: pin summary (`pins: all v13`) + links to batch export and health.
**Variants.** 30-video canonical; single-video (Milestone A, same table with one row); paused/degraded (banner above, actions limited, the table still readable); cancelled (rows read-only, `CANCELLED` chips, reason in the header); progress-feed stalled (`progress feed delayed — last update 22 s ago` in warning, and the counter is *not* presented as current).
**States.** Loading (7 skeleton rows at 44 px + skeleton counters — the header keeps its geometry); partial (per-row error placeholder `could not load video — retry`, counters marked `partial`); error (whole-table error block with last-good timestamp and `Nothing was changed`); empty (impossible for a real batch; legacy: `This batch has no videos`).
**Announcements.** One polite live region, debounced to at most one message per 5 s: `18 of 30 complete. 3 need attention.` Never per row, never per tile (AX-10). Transitions into `Needs attention` or `FAILED` are also reflected in the Overview badge; nothing toasts (IP-05 anti-noise).
**Keyboard.** The table is a grid-like list of links: `↑`/`↓` move row focus, `Enter` opens the video at its gating tab, `r` opens retry scope **only** on a failed row and only after focus is on that row, `f` cycles the filter. Column headers are sortable only on `#` and `Last event` (stable order matters more than sorting; group order is fixed).
**Do not.** Do not paginate at 30 (IP-05). Do not collapse the failed row into a summary. Do not show a spinner over the table during generation (AX-28).

### UC-12 — Batch row

**Trace.** W-03; R-021-1/2; IP-05.
**Anatomy.** `#18` (mono 700) · title (600, truncates with a full-title tooltip) · stage code (mono) · state chip · attention reason (12 px, glyph + text) · pins (`v13` or mixed summary `v13 ×5 · v14 ×3`, 12 px mono) · last event (relative `2 min`, absolute in the accessible name) · actions (`Open` / `Retry scope`).
**Variants.** needs-attention, running, waiting (benign, `--text-tertiary` clock), not started (40% opacity on title and stage, full-strength chip), complete (title normal, no actions except Open), cancelled (title 60% + `CANCELLED`), failed (3 px danger left bar).
**States.** Default / hover (`--surface-hover`) / focus-visible (inset 2 px accent) / selected (when returning from a video, the originating row is marked for 3 s with `--surface-selected` then fades — 220 ms, opacity only).
**Do not.** Do not offer a bare `Retry` (IP-06: retry scope or nothing). Do not colour the entire row; the left bar and the chip are enough.

### UC-13 — Retry-scope panel

**Trace.** IP-06, W-08; R-011-1/2/3, R-022-2; C-17, C-18, C-19, C-20; AX-25.
**Anatomy.** Panel 560 px wide (or right-hand column of S-15). Header block: `Video 18 · stage NA (narration) · failed` (18/600) then a 4-row key/value list in 12 px mono: provider/model, request id, error class + HTTP status, attempts + backoff used. Body: `Will re-run` (3 rows, `narration — 1 TTS call`, `timing — derived from new alignment`, `render — 1 pass`), `Will not re-run (stored, reused)` (one line: `17 images (v13) · script rev 4 approved · storyboard 17 scenes · 5 sources`), a green-tinted guarantee callout, and conditionally an amber `unknown charge` callout and/or a warning `idempotency-unprotected` callout. Footer: `Cancel` (44 px secondary, **initial focus**) then `Retry narration · 1 TTS call` (44 px primary).
**Variants.** Transient with attempts remaining (`attempt 2 of 3; next retry in 4 s (automatic)` + `Retry now`); transient exhausted (`3 of 3 attempts used at 16 s backoff`); non-retryable (`Not retryable: HTTP 401 from ElevenLabs. Retrying fails the same way. Fix the key in Settings, then retry.` — retry disabled until the key is present again); unknown charge (`This attempt timed out at 60 s. It may have been billed. It is recorded as unknown charge — not as unbilled.`); idempotency-unprotected (`This stage does not support an idempotency key; a crash between call and save can duplicate one billable call.`); restart summary (separate panel: `Worker restarted at 14:02 UTC. 4 videos resumed at their last persisted stage. 0 completed stages re-ran. 0 duplicate attempt rows.`).
**States.** Default, retrying (`Retrying… attempt 1 of 3 · next backoff 4 s` — the button keeps its label and gains a spinner), success (panel collapses and the stage chip becomes `running` then `done`), failure (a new attempt block is appended; the panel never replaces its history), disabled (non-retryable, with the reason in `aria-describedby`).
**Keyboard.** Focus starts on Cancel; Esc closes; `Tab` then `Enter` is required to retry (AX-04). The scope text is in a `role="region"` labelled `Retry scope for video 18 stage narration` so a screen reader can jump to it.
**Do not.** Do not show a retry button without the scope (the component is the scope; if the server cannot compute it, the button is absent and the panel says `Scope could not be computed — nothing can be retried yet`, which mirrors IP-01's C-07 honesty).

### UC-14 — Citation / claim row

**Trace.** S-10, IP-10; R-027-2/3; C-10; W-05.
**Anatomy.** Table row 56 px: claim text (13 px, max 2 lines, quotes included) · state chip (`sourced` / `url unreachable` / `unsourced` / `acknowledged unsourced` / `non-factual`) · source cell (domain + title + retrieval time, 12 px mono; `—` when absent; `404 · checked 14:18` in danger when unreachable) · actions (``Attach source`` / ``Reword`` / ``Acknowledge``, 13 px quiet buttons).
**Variants.** Five states × three action sets. `sourced` offers `Open source`; `url unreachable` offers `Retry check` / `Replace source`; `unsourced` offers all three actions; `acknowledged unsourced` shows `acknowledged by operator · 2026-10-20T16:12:00Z` and offers `Revoke acknowledgement`; `non-factual` shows `reworded` and offers `Undo`.
**States.** Default, hover, focus, action-pending (`Attaching…`), error (source rejected: `That source scores 1.2, below the 1.5 acceptance threshold.`).
**Source picker (see UC-20).** Only accepted results (`rerank_score ≥ 1.5`) are offered; each shows score, domain, date and a reachability badge (`2xx`/`3xx` pass). A rejected source is listed below, greyed, and not selectable.
**Do not.** Do not allow approval while any row is `unsourced` or `url unreachable` (IP-10); the approve button carries the count as described text. Do not hide the claim text inside a tooltip — arbitration requires reading the sentence.

### UC-15 — Acknowledge dialog

**Trace.** IP-10, IP-14; R-027-3; C-10.
**Anatomy.** Dialog 480 px, `--r-4`, padding 20: title `Acknowledge 1 claim as unsourced?`, the claim in quotes at 14 px, one paragraph `This claim will be exported as unsourced. The video will still be approved. Recorded against this video with your operator account and the UTC time.`, and a footer `Cancel` (secondary, initial focus) / `Acknowledge claim` (primary). No typed confirmation — this is a recorded acknowledgement, not a destructive act.
**States.** Default, submitting (`Acknowledging…`), error (`Could not record the acknowledgement — nothing changed. Retry.`), success (dialog closes, row flips to `acknowledged unsourced`, the count in the approval block updates, focus returns to the row).
**Keyboard.** Focus trap, `Esc` = cancel without recording, focus returns to the invoking row's `Acknowledge` button (AX-09). The dialog is `role="dialog" aria-modal="true"` with `aria-labelledby` on the title and `aria-describedby` on the claim.

### UC-16 — Export integrity panel

**Trace.** S-17, W-10, IP-12; R-014-2/3, R-015-5; C-23.
**Anatomy.** Panel: header `manifest.csv check` + integrity chip (`integrity ok` / `blocked`); five check rows in 12 px mono with a right-aligned result (`rows = videos … 29 ok`, `posting_order 1..N unique … 1..29 ok`, `filenames unique … ok`, `referenced files present … 29/29 ok`, `secrets scan … 0 matches`); an eligibility line (`eligible 29 · excluded 1 (#18 FAILED: narration — retry to include)`); the column preview (`posting_order, filename, title, srt, vtt, sidecar, duration_s, posted_flag`); footer with `Export ZIP · 29 videos` (44 px primary) and a secondary `Fix #18 first`.
**Variants.** ok; blocked (a failing check turns its row red with the failing value, the download button is replaced by `Export blocked` + the reason, and nothing downloads — C-23); building (`Building ZIP… 29 of 29 files` with a determinate per-region bar); failed (`ZIP build failed at <step>. Nothing was downloaded.`); posting-order edit (OQ-5: drag/`Alt+↑↓` on eligible rows, integrity re-runs on every change).
**Do not.** Do not offer a download button that produces a broken ZIP. Do not hide exclusions in a tooltip — exclusions are a table row with a reason.

### UC-17 — Data table (generic) and attempt-row variant

**Trace.** S-08, S-10, S-17, S-18, S-19; IP-08; AX-10.
**Anatomy.** `table` with a sticky `thead` (28 px, 11 px uppercase labels, `--surface-raised`), `tbody` rows at the density of §4.4, 1 px `--border-subtle` row rules, no vertical rules, no zebra striping (stripes fight the state tints).
**Variants.** `batch` (44 px, columns per UC-11), `claims` (56 px, wrapping first column), `posting` (44 px: title · platform · posted at · URL · `posted_flag`), `attempts` (36 px debug: provider · model · prompt hash · request id · `billed_units (debug)` · idempotency · charge; **no totals row, no export, no sort by units** — IP-08).
**States.** Default, row hover, row focus, sortable header (only where stated), empty (rendered by UC-24 inside the table body as a full-width row), loading (skeleton rows at the exact row height), error (one full-width row with an error message and a retry, other rows still rendered), partial (per-row error placeholders).
**Accessibility.** Native `<table>` with `<th scope="col">`, a `<caption class="sr">` naming the dataset, and `aria-sort` on sorted headers. Row actions are real links/buttons, not clickable `<tr>`s; the whole-row click is a convenience that duplicates the link, never the only path.

### UC-18 — Buttons

**Trace.** Everywhere; AX-04, AX-17, IP-14; C-09.
**Anatomy.** Height 28 (compact, table toolbars) / 32 (default) / 44 (primary review action); padding 10/12/16; `--r-2`; 1 px border; 16 px glyph + 6 px gap + 13/14 px 600 label; optional trailing `sub` label (12 px, 400, `--text-secondary`) for a quantity: `Release remaining 14 [14 image calls]`.
**Variants.** `primary` (`--accent-fill`, white label — the one commit), `secondary` (default; `--control-fill`), `quiet` (transparent, link-coloured, for row actions), `danger` (`--danger-fill`, white label, destructive only), `icon` (32×32, `aria-label` required), `disabled`.
**States.** default / hover / focus-visible (2 px accent outline, 2 px offset) / active (background 8% darker, no transform) / disabled (`--control-fill`, `--text-disabled`, `not-allowed` cursor, and the reason in adjacent text) / loading (`aria-busy="true"`, spinner replaces the leading glyph, label becomes a present-participle: `Signing in…`, `Retrying…`, `Building ZIP…` — the label never becomes just a spinner).
**Rules.** One filled primary per region. Destructive buttons are never placed adjacent-and-equal to a primary in a footer without ≥8 px separation and a different width or an explicit ordering (Cancel left, destructive right, primary never right of a destructive). Disabled buttons are never the only explanation of why something cannot proceed (AX-11): the reason lives in visible text wired with `aria-describedby`.
**Do not.** Do not use "OK" / "Cancel" for a spend decision (C-01 rule 3). Do not use an icon-only button for approve, replace, retry, export or delete.

### UC-19 — Form field

**Trace.** S-01, S-04, S-07, S-10, S-18, S-20; IP-09; AX-11, AX-14.
**Anatomy.** Label 13 px 600 (always visible; no placeholder-as-label), control 32 px (44 px on the login and on destructive confirmations), helper 12 px tertiary below, error 12 px danger with ⚠ below, optional counter (word budget) right-aligned in the label row.
**Variants.** text, textarea (min 88 px, auto-grow to 320 px, then inner scroll), number (with unit suffix inside the field: `30` / `75 s`), password (login only, with a show/hide toggle that is a 32 px icon button), read-only value (mono, `--surface-inset`, no border — used for `series version v13`), disabled.
**States.** default / hover (border `--border-strong`) / focus-visible (2 px outline + accent border) / filled / invalid (danger border + error text + `aria-invalid` + `aria-describedby`) / disabled / read-only / saving (`aria-busy`, 16 px spinner in the label row, field stays editable until the response) / conflict (IP-09 inline banner above the field, typed text preserved).
**Word-budget variant (S-10).** The label row carries `228 words → 75.1 s @ 3.035 w/s` and `band 216–239 words (71.2–78.7 s)` in 12 px mono; when out of band the counter turns `--warning` and adds `Outside the band, narration will most likely miss the ±5% duration check and return here after one TTS call.` (C-11).
**Do not.** Do not use a placeholder to carry a unit or a constraint. Do not clear a field on validation failure.

### UC-20 — Select and source picker

**Trace.** S-04, S-07, S-18, S-10 (source picker), S-19 filters.
**Anatomy.** Native `<select>` styled to the field spec (32 px, `--r-2`, `--border-default`, 12 px external chevron, `appearance: none`), because a native select is keyboard- and screen-reader-correct for free and this product has no need for a custom listbox in most places.
**Source picker (the one custom combobox).** Trigger: `Attach source` button → popover 480 px, `--r-3`, e-2: a 32 px search input, then a list of accepted sources (`rerank_score ≥ 1.5`) each 64 px: title (2 lines), `domain · 2026-10-14 · score 1.52` in 12 px mono, and a reachability badge (`2xx ok` in success / `404` in danger). Rejected sources appear below a divider, dimmed, non-selectable, with `below 1.5 threshold`. Footer: `Paste a URL instead` (opens a text field + `Check & attach`).
**States.** closed / open / searching (skeleton 3 rows) / empty (`No accepted sources for this query. Widen the search or reword the claim.`) / error (`Source search failed — <class>. Nothing was attached.`) / checking (`Checking reachability…`) / attached (popover closes, row flips to `sourced`).
**Keyboard.** `↓`/`↑` move, `Enter` selects, `Esc` closes and returns focus to the trigger, type-ahead filtering. The reachability result is announced (`Source reachable, 200`) because it changes what the operator may do next.

### UC-21 — Dialog

**Trace.** IP-09, IP-10, IP-13, IP-14, AX-09; S-13 compare, acknowledge, typed confirms, 409 conflict.
**Anatomy.** Scrim `rgba(6,8,10,.72)` (not a blur — blur is a performance cost on a NAS-served container and hides the context the operator needs); surface `--surface-panel` with `--surface-raised` header, `--r-4`, e-3, max 640 px (960 px for compare), padding 20, footer with buttons right-aligned.
**Variants.** informational (one action), decision (two actions, Cancel initial focus), typed-confirm (destructive: input must equal `delete` or `cancel batch`, confirm disabled until it matches, and the confirm restates count + bytes or in-flight calls), acknowledgement (UC-15).
**States.** opening (320 ms opacity + 4 px rise), open, submitting, error (inline in the footer, dialog stays open), closing.
**Accessibility.** `role="dialog" aria-modal="true"`, `aria-labelledby` + `aria-describedby`, focus trap, `Esc` closes without committing, focus returns to the opener (AX-09). The scrim is not clickable-to-close for destructive dialogs (a mis-click must not dismiss a confirm) — it is clickable only for informational ones.
**Do not.** Do not use a dialog for the change-impact panel (DI-02), for a first-run empty state, or for a success message.

### UC-22 — Toast

**Trace.** Restricted by IP-02 and IP-05; used only for non-state confirmations.
**Anatomy.** 320 px min, bottom-right 24 px inset, `--surface-raised`, `--border-default`, `--r-3`, e-2, 12 px padding, 16 px glyph, 13 px text, dismiss icon button.
**Variants.** success (`Package downloaded — 5 files, 41.2 MB`), error (`Copy failed — clipboard unavailable in this browser`), info (`Link copied`).
**States.** enter (320 ms), visible 8 s, hover pauses the timer, dismiss.
**Rule.** **Never** used for: stage completion, gate opening, version save (IP-02 explicitly says the version chip, not a toast, is the record), progress, or a failure that needs a decision (those live in the page). If a message needs an action, it is not a toast.
**Accessibility.** `role="status"` (polite), one at a time, dismissible by keyboard, never steals focus.

### UC-23 — Status strip, degraded banner and live regions

**Trace.** IP-07, W-09, C-12…C-16; R-018-1/2/3; AX-06, AX-08, AX-10, AX-27.
**Anatomy.** (1) Status strip per UC-01. (2) Degraded banner 20 px below the strip, full content width, amber left border 4 px + `--surface-warning-tint`: bold cause line, then `blocked / still works / system / next action` in 13 px. (3) Two live regions at the end of `<body>`:
  - `#live-status` `aria-live="polite" aria-atomic="true"` — progress summaries, gate announcements, stage settle messages, debounced to ≤1 per 5 s.
  - `#live-alert` `aria-live="assertive" aria-atomic="true"` — only for a degraded transition and for "your session expired, draft preserved". Never for routine progress.
**Variants.** ready, degraded-db, degraded-asset-store, provider-down, queue-backup, disk-near-limit, rate-limit (informational, not degraded), startup-blocked (SY-1 full page).
**States.** The banner persists while the condition is true; it is dismissed only by the condition clearing, never by a close button. On clear, a polite announcement: `Service ready. The database is reachable again.`
**Do not.** Do not stack banners: one banner per condition, ordered by severity and collapsed behind `+2 more` only below 1024. Do not use a toast for a degraded state.

### UC-24 — Progress meter, count pair and empty state (composite primitives)

**Trace.** AX-27, AX-28, UX §6.2, C-22; used by many screens.
**Progress meter.** 2 px tall, full container width, `--surface-inset` track, `--running` or `--success` fill, determinate only (`11 of 17`). Indeterminate is a 2 px barber-pole **inside the region**, never a full-panel spinner. Every meter has a text equivalent adjacent (`11 of 17 scenes`).
**Count pair.** The unit of the product's copy: `<number> <noun>` in tabular figures with the noun in `--text-secondary` and the number in `--text-primary`, e.g. `17 image calls`, `1 TTS call`, `1 render pass`. Compounds are separated by ` · ` (middle dot, 8 px each side). A count pair never contains a currency symbol, a percentage of a budget, or the word "cost".
**Empty state.** 320 px max width, centred vertically in its region: 24 px glyph in `--text-tertiary`, a 16/24 600 sentence stating the situation, one 14 px line of what to do, one 44 px primary action. First-run S-02 uses exactly: `No series yet. No batches yet.` + `Create series` + quiet line `Three provider keys are checked in Settings.`
**Do not.** Do not illustrate empty states with mascots or 3D art. Do not show a disabled nav item as a feature teaser.

## 6. High-fidelity screen mockups

Eleven mockups: the ten wireframed screens (W-01…W-10) plus S-01 login, which the UX spec gives as a screen rather than a wireframe. Each carries exact measurements and a box render at the reference width of **1440 px** (content width 1,176 px after the 216 px rail and 24 px gutters). All layouts are stated in the same units the implementation uses: CSS px, no scaling, no "about".

The renders are structural proof, not artwork: images are shown as `[ 9:16 ]`, text is truncated to fit, and the mono columns are aligned so that digit alignment can be checked by eye. Colours, type and component states are specified in §2, §3 and §5, and are rendered for real in `mockups/ui-mockup.html`.

Shared measurements for every screen in the workspace (S-09…S-16): breadcrumb 20 px, title row 28 px, stage rail 56 px, tab bar 34 px, gaps 8/8/8, content top padding 24, footer 32 px. The workspace header block is therefore **196 px** from the top of the content area.

---

### 6.1 S-01 — Login

**Trace.** S-01, US-004, R-015-1…4, AX-02, SY-2. **Milestone A.**
**Purpose.** The only way in. No registration, no reset, no account surface, no "remember me".

| Region | Measurement |
|---|---|
| Page | Centred card, 400 px wide, `--surface-panel`, `--r-3`, 1 px `--border-subtle`, e-1, padding 32 |
| Wordmark | `reels-generator` 32/40 600, `--text-primary`, 24 px above the form |
| Sub-line | `Private, LAN-only. One operator account.` 13/20, `--text-secondary`, 8 px below the wordmark |
| Fields | Username 44 px, Password 44 px, 16 px apart, label above 13/20 600 |
| Submit | 44 px full-width, primary, 24 px below the password |
| Error | 12 px danger with ⚠, 8 px below the password, above the submit, `role="alert"` |
| Footer note | `No registration. No password reset. Access is by the seeded operator account only.` 12/18 `--text-tertiary`, 24 px below the card's last control |

```
+------------------------------------------------------------------------------+
|                                                                              |
|                         +----------------------------------+                 |
|                         |  reels-generator                 |                 |
|                         |  Private, LAN-only.              |                 |
|                         |  One operator account.           |                 |
|                         |                                  |                 |
|                         |  Username                        |                 |
|                         |  [ operator                   ]   |  44 px         |
|                         |                                  |                 |
|                         |  Password                        |                 |
|                         |  [ **********************   (o) ]|  44 px, eye 32 |
|                         |                                  |                 |
|                         |  [          Sign in           ]  |  44 px primary |
|                         |                                  |                 |
|                         |  No registration. No reset.      |                 |
|                         +----------------------------------+                 |
|                                        400 px                                |
+------------------------------------------------------------------------------+
```

**States.** Empty (no error, no links); submitting (`Signing in…` + spinner, disabled, aria-busy); wrong credentials (`Wrong username or password` — identical for both fields, no account enumeration, error announced assertively); attempts throttled (`Too many attempts. Try again in 30 s.`); session expired on a protected route (the same page with a banner above the card: `Your session expired. Your unsaved draft is preserved.` — SY-2, AX-21); startup blocked (SY-1 replaces this page entirely, C-16).
**Keyboard order.** Username → Password → show/hide → Sign in. `Enter` in either field submits. Focus lands on Username on load; after a failed attempt focus returns to Password with the error announced. No autofocus trap, no CAPTCHA, no social login.

---

### 6.2 W-01 — Overview / attention inbox (S-02)

**Trace.** W-01, S-02, J-1, IP-05, R-019-3/R-022-1, C-22. **Milestone A (single video) / B (batches).**
**Purpose.** "What needs me now", across every batch — the landing screen.

| Region | Measurement |
|---|---|
| Page header | Title `Needs attention` 24/32 + count `(4)` in `--accent`; right side: `Review next needing attention →` 32 px button |
| Attention list | One card per batch, `--surface-panel`, `--r-3`, 1 px border; inner rows 48 px, 12 px gaps |
| Attention row | `#7` 48 px mono 700 · reason chip-less text (`script approval`) 200 px · detail (`script rev 4`) 180 px · relative time 96 px right-aligned · `Open` 80 px |
| Batch group header | 40 px: title (13/20 600) · `18 of 30 complete` mono · `open batch →` link |
| Group stack | `Running (9)`, `Not started (5)`, `Complete (9, collapsed)` — 40 px headers, 8 px apart |
| Empty (first run) | `UC-24` block centred in the content area: `No series yet. No batches yet.` + `Create series` (44 px) + quiet line |

```
+---------------------------------------------------------------------------------------+
| * reels-generator      [ Service: ready ]   [ 4 need attention ]        operator      |
+-------------+-------------------------------------------------------------------------+
| Overview  4 |  Needs attention (4)                    [ Review next needing attention >]|
| Series      |  +-------------------------------------------------------------------+  |
| Batches     |  | Quiet Mind / batch 2026-10-20-a                 18 of 30 complete  |  |
| Posting     |  |  #7   script approval   script rev 4            2 min ago   [Open]|  |
| Health      |  |  #12  image review      3 of 17 generated      14 min ago   [Open]|  |
|             |  |  #18  failed: narration attempt 3 of 3          1 h ago   [Retry] |  |
|             |  |  #22  blocked: 3 unsourced claims (factual)     3 h ago   [Open]  |  |
|             |  +-------------------------------------------------------------------+  |
|             |  Running (9)      12 of 30 complete                     [open batch]  |
|             |  Not started (5)                                                      |
|             |  Complete (9)     [show]                                              |
+-------------+-------------------------------------------------------------------------+
   216 px                                      fluid, max 1600, padding 24
```

**States.** First-run empty (above); loading (3 skeleton cards, 3 skeleton rows each, counters as skeleton bars — no spinner over the page); partial (one batch card fails: `could not load batch — retry`, other cards render); whole-feed error (`Status feed unavailable (last good 14:02 UTC). Nothing was changed.` + `Retry`); degraded (banner above the list; the list stays usable — R-018).
**Notes.** Each row links straight to the gating tab, not to the video's default tab (IP-03). The badge in the rail is the only global counter (J-1); it counts videos, not batches, and its accessible name is `4 videos need attention`.
**Keyboard order.** Skip link → rail → title actions → attention rows (each row is one tab stop with the row action as the primary link; `→` on a focused row opens its detail) → batch groups → footer links.

---

### 6.3 W-02 — Batch create (S-07)

**Trace.** W-02, S-07, R-019-1…4, US-032, D2, D9. **Milestone B.**

| Region | Measurement |
|---|---|
| Page | Form card 640 px wide, padding 24, `--surface-panel` |
| Fields | Two-column form (§4.3): label 160 px + control 280 px; rows 20 px apart |
| Count field | 88 px wide, suffix-free, helper `Integer 1–30` |
| Duration field | 88 px wide + `s` suffix inside; helper `series default 75; 10–180, ≤90 advised` |
| Read-only pin | `v13` mono on `--surface-inset`, no border |
| Volume block | Inset panel `--surface-inset`, padding 16, 12 px mono lines |
| Footer | `Cancel` (32 px) + `Create batch` (44 px primary, disabled until valid) at 24 px gap |

```
+---------------------------------------------------------------------------------------+
| < Quiet Mind                                                          signed in: operator|
+---------------------------------------------------------------------------------------+
|  New batch                                                                            |
|                                                                                       |
|  Videos to produce        [ 30 ]       Integer 1-30                                   |
|  Duration per video       [ 75 ] s     series default 75; 10-180, <=90 advised         |
|  Series version            v13         pinned at creation; unchangeable              |
|  Mode                      factual     (series setting, versioned)                    |
|                                                                                       |
|  Expected per video  (informational volume, not a cost estimate)                      |
|    17 image calls . 1 TTS call . 1 render                                             |
|    text + research calls set by the authoring stage                                   |
|  For 30 videos       510 image calls . 30 TTS calls . 30 renders                       |
|                                                                                       |
|  No schedule. No timer or automation can create a batch.                              |
|                                                    [ Cancel ]   [ Create batch ]       |
+---------------------------------------------------------------------------------------+
```

**States.** Default (30, 75 s); invalid count (`Batch target must be an integer from 1 to 30.`); invalid duration (`Hard cap is 180 s. Recommended ceiling 90 s.`); creating (`Creating 30 videos…` + per-region bar, form disabled, `aria-busy`); created (redirect to S-08, `0 of 30 complete`); series archived (form disabled, reason `Archived series cannot be used for new batches`, R-001-3); service not ready (HTTP 503 copy, C-12, submit replaced by `Service not ready`); version unresolvable (`The series version could not be resolved — the batch was not created and nothing was scheduled.`).
**Notes.** The word "cost" never appears; the block is labelled `informational volume, not a cost estimate` verbatim. `510` is computed (17 × 30) and tabular. No scheduling control exists — the sentence is permanent, not conditional.

---

### 6.4 W-03 — Batch detail, 30 videos (S-08)

**Trace.** W-03, S-08, IP-05, IP-06, R-019-3, R-021-1, R-022-1, C-22. **Milestone B.**

| Region | Measurement |
|---|---|
| Header | 96 px total: breadcrumb 20 + counter row 28 + actions row 40, 8 px gaps, padding 0 24 |
| Counter | `18 of 30 complete` 20/28 600 + `· 3 need attention` accent + `· 9 running` + `· 1 failed` danger + `last update 2 s ago` 12 px mono right |
| Filter group | Segmented control 28 px: `All · Attention · Failed`, active = `--surface-selected` + accent text |
| Table | columns `48 · min 280 · 96 · 132 · 260 · 120 · 96 · 120`; header 28; rows 44; group headers 32 |
| Footer | 40 px: `pins: all v13` mono + `[batch export]` `[health]` links |

```
+---------------------------------------------------------------------------------------+
| Overview / Quiet Mind / batch 2026-10-20-a                                            |
| 18 of 30 complete . 3 need attention . 9 running . 1 failed        last update 2 s ago|
| [ Review next needing attention -> ]        [ All | Attention | Failed ]              |
+-----+---------------------------+------+------------------+--------------------------+
|  #  | Title                     |Stage | State            | Attention reason         |
+-----+---------------------------+------+------------------+--------------------------+
| NEEDS ATTENTION (3)                                                                   |
| #7  | Why We Procrastinate      | SC   | [LOCK awaiting ] | script approval . rev 4  |
| #12 | The Cost of Noticing      | IM   | [LOCK awaiting ] | image review . 3 of 17   |
| #18 | Two Kinds of Rest         | NA   | [ X  failed    ] | failed: narration . 3/3  |
| RUNNING (9)                                                                           |
| #4  | The 90-Second Rule        | IM   | [(o) running   ] | images 11/17             |
| #5  | Small Rooms, Big Feelings | RE   | [BAN blocked   ] | waiting: render slot 1/1 |
| #6  | What Silence Does         | IM   | [BAN blocked   ] | waiting: rate limit 8 q  |
| NOT STARTED (5)    #25 .. #29                                                         |
| COMPLETE (13, collapsed)                                                     [show]   |
+---------------------------------------------------------------------------------------+
| pins: all v13                                     [batch export]   [health]            |
+---------------------------------------------------------------------------------------+
```

**States.** Required sub-states in the same screen (UX §6.2): 0 complete; 1 running + 29 not started; 12 complete + 1 failed; 29 complete + 1 failed; 30 approved awaiting export; 30 exported with 22 posted. Plus: feed stalled (`progress feed delayed — last update 22 s ago`, counter marked stale, numbers not presented as current — AX-27); batch cancelled (read-only, `CANCELLED` chips, reason line); degraded (banner, per-video actions limited to read-only); loading (skeletons at exact heights).
**Notes.** A failed row offers `Retry scope`, never a bare retry, and the scope panel (W-08) opens over the table without navigating away. The failed row's 3 px left bar plus the chip word guarantee that "which one failed and at what stage" is answerable without opening anything (the canonical case in UX §6.2).

---

### 6.5 W-04 — Video workspace shell (S-09…S-16)

**Trace.** W-04, IP-03, S-09…S-16, R-002-4, R-005-2/3. **Milestone A.**

| Region | Measurement |
|---|---|
| Breadcrumb row | 20 px: `Overview / Quiet Mind / batch a / video 7 of 30` + `[<] [>]` 32×32 at right, 8 px gap |
| Title row | 28 px: video title 16/24 600 left, state chip `lg` (28 px) right |
| Stage rail | 56 px, 11 nodes, per §5 UC-03 |
| Stale ribbon (conditional) | 28 px directly under the rail |
| Tabs | 34 px, 7 tabs, 2 px accent underline on active |
| Content | 2 columns `1fr / 360` gap 24, scrolls independently; impact panel sticky `top: 40px` |
| Footer | 32 px sticky: pins, mode, calls used |

```
+---------------------------------------------------------------------------------------+
| Overview / Quiet Mind / batch a / video 7 of 30                    [ < ]  [ > ]       |
| "Why We Procrastinate"                          [LOCK awaiting script approval]       |
| T done . RS done . SC*await . SB . IM . NA . TC . RE . QC . FA . EX                   |
| ^current                                      stale: none                              |
+---------------------------------------------------------------------------------------+
| Topic | Script | Storyboard | Scenes | Audio | Render | Export                        |
+------------------------------------------------------+--------------------------------+
|                                                      | CHANGE IMPACT                  |
|   (tab content)                                      | (sticky, 360 px)               |
|                                                      |                                |
+------------------------------------------------------+--------------------------------+
| pins: T v13 RS v13 SC v13 . mode: factual . 1 TTS call used . 0 image calls           |
+---------------------------------------------------------------------------------------+
```

**States.** Shell-level: loading (rail renders with last-known states, content region skeletons); a tab whose data fails (error inside the tab, rail intact — the operator never loses their place); blocked (`IM`/`NA` show `blocked: script not approved` and offer no run control — R-005-2); session expiry mid-edit (SY-2 on top, draft preserved, returning restores the tab and scroll position); worker restart (`resumed after restart` in the rail footer area, no modal).
**Notes.** The rail is navigation *and* status (IP-03). `FA` is a gate, not a producing stage, and is tagged permanently. The pins footer is always present, including on a fresh video (`T — RS — SC —`), so its absence is never a signal.

---

### 6.6 W-05 — Script review, claims and change impact (S-10)

**Trace.** W-05, S-10, IP-01, IP-10, R-005-2/4, R-003-2, R-009-3, R-027-3, C-01/C-09/C-10/C-11. **Milestone A (blocked-by-citations states in B).**

| Region | Measurement |
|---|---|
| Status bar | 40 px: `Script rev 4 (unsaved changes)` 13 px mono + 8-gram chip (`done` / `failed`) + approve button 44 px at right |
| Budget bar | 40 px: `228 words → 75.1 s @ 3.035 w/s` + `band 216–239 words (71.2–78.7 s)` 12 px mono |
| Editor column | `1fr`, max 720 px of text at 68ch; hook/narration/ending blocks 16 px apart; title/description/hashtags below a 1 px divider |
| Claims block | Header 24 px (`CLAIMS (14 factual · 11 sourced · 3 unsourced)`) + table rows 56 px |
| Impact column | 360 px, `UC-06`, sticky |
| Approval block | 56 px under the editor: blocked chip + count + 44 px approve (disabled) |

```
+---------------------------------------------------------------------------------------+
| Script rev 4 (unsaved changes)   [8-gram pass]                    [ approve: BLOCKED ]|
| 228 words -> 75.1 s @ 3.035 w/s       band 216-239 words (71.2-78.7 s)                |
+---------------------------------------------------------+-----------------------------+
| Hook                                                    | CHANGE IMPACT               |
|  You have fourteen unfinished projects and no memory... | what changes                |
| Narration                                               |  script rev 4 -> rev 5      |
|  When a task feels large, the brain treats the first... | becomes stale (4)           |
| Ending                                                  |  scene prompts (17)         |
|  Start with the smallest possible proof...              |  narration (1 TTS call)     |
|                                                         |  timing & captions          |
| title / description / hashtags                          |  render (1 pass)            |
| [...                                                    | survives                    |
|                                                         |  17 stored images (v13)     |
| CLAIMS (14 factual . 11 sourced . 3 unsourced)          | calls if regenerated        |
| c1  "Sleep consolidates procedural memory."  nih.gov ok |  image 0 . TTS 1 . render 1 |
| c7  "Most adults need eight hours."          --  !     |                             |
| c9  "Blue light halves melatonin."           404 !      | [Apply edit (no regen)]     |
| c12 "Naps improve recall."                   --  !      | [Apply and regenerate now]  |
| [attach source] [reword as non-factual] [acknowledge]   |                             |
+---------------------------------------------------------+-----------------------------+
| [X blocked] 3 of 14 factual claims have no resolvable source.   [ Approve script ]    |
+---------------------------------------------------------------------------------------+
```

**States.** No script (blocked on topic approval — the tab shows the reason and a link to S-09); drafting (`Drafting… schema attempt 2 of 3` with the retry counter, no billable stage running); schema failure after 3 retries (blocking panel: failing field name, schema version, `3 of 3` — R-004-2); 8-gram hit (`8-gram scan: FAIL — a run of ≥8 words matches reference 2. Reword before approval.`); out-of-band word budget (warning counter + C-11); approval blocked by citations (C-10, exact); approved (`Approved rev 4 · operator · 2026-10-20T15:41:00Z` with the approve control replaced by a record line); 409 conflict (IP-09 banner above the editor with *Compare* / *Keep my text* / *Discard mine*).
**Notes.** The no-spend commit is first in reading order, first in tab order and the only one on `Enter` (AX-04). The approve button's disabled reason is visible text wired by `aria-describedby`, including the count (AX-11). The 8-gram result is operator-visible only and never leaves the server (R-003-2/3).

---

### 6.7 W-06 — Scene grid with first-three checkpoint (S-12)

**Trace.** W-06, S-12, IP-04, DI-10, PRD §10, R-007-1/2, R-006-3, US-019/US-020/US-030. **Milestone A (replace) / B (reorder).**

| Region | Measurement |
|---|---|
| Header | 40 px: chip `awaiting image review` + `3 of 17 generated · 14 not started` mono + `Release remaining 14` 44 px primary with sub-label `14 image calls` |
| Checkpoint banner | 40 px, amber-tinted: `CHECKPOINT — comparing scenes 1–3 for the recurring protagonist` + secondary `Fix scenes 1–3 first` |
| Grid | `repeat(auto-fill, minmax(168px, 1fr))`, gap 12; 6 columns at 1440; tile per UC-08; 3 rows for 17 |
| Selection bar | 44 px sticky bottom of the tab: `selected: S03 · replace 1 image call · reorder 0 calls` + `[Replace image]` 44 px, `[↑] [↓]` 44×44 |
| Reorder strip | 56 px, appears above the selection bar while reordering (UC-10) |

```
+---------------------------------------------------------------------------------------+
| Scenes   [LOCK awaiting image review] 3 of 17 generated . 14 not started              |
| [ Release remaining 14  (14 image calls) ]                                            |
| CHECKPOINT  comparing scenes 1-3 for the recurring protagonist      [Fix 1-3 first]   |
+---------------------------------------------------------------------------------------+
| [S01 ready v13] [S02 ready v13] [S03 ready v13] [S04 11/17] [S05 stale] [S06 failed]  |
| [ 9:16 thumb  ] [ 9:16 thumb  ] [ 9:16 thumb  ] [ 9:16    ] [ 9:16    ] [ attempt 3/3]|
|  3.4 s          2.9 s          3.1 s          2.6 s        3.8 s        2.2 s         |
|                                                                                       |
| [S07 not started] [S08 not started] [S09] [S10] [S11] [S12]                           |
| [S13] [S14] [S15] [S16] [S17]                                                         |
+---------------------------------------------------------------------------------------+
| selected: S03 . actions: [Replace image 1 image call] [^] [v]  reorder: 0 image, 0 TTS |
+---------------------------------------------------------------------------------------+
```

**States.** 0 of 17 (all `not run`, stage `blocked: script not approved`); partial (the normal state — some ready, one generating, one failed, one stale); all 17 ready + checkpoint cleared; tile failure (`failed` chip + `attempt 3/3` + a `Retry scope` action in S-13); no recurring protagonist (`Protagonist checkpoint not applicable — this series has no recurring character` replaces the checkpoint banner); provider down (banner, tiles keep their last image, replace disabled with reason); rate limit (benign `waiting: rate limit` — not an error).
**Notes.** Scene ids are stable and shown at 12 px mono; the pin is on every generated tile; the grid never hides not-started tiles. Reorder and replace are both reachable with the keyboard (`Alt+↑/↓`, `r`) and both announce their consequence before commit (AX-05, IP-04).

---

### 6.8 W-07 — Invalidation preview, conditional aspect-ratio case (IP-01)

**Trace.** W-07, IP-01, R-006-2, C-05, AX-04. **Milestone A.**

| Region | Measurement |
|---|---|
| Context header | 40 px: `Change aspect ratio 9:16 → 4:5` + `(unsaved)` in tertiary |
| Stale groups | 24 px rows, bullets in `--stale` |
| Conditional block | Inset panel, amber 1 px border, 16 px padding, containing `pending reframe check (local, no provider call) … [checking]` and the two outcomes on separate lines |
| Survives | 24 px rows, bullets in `--success` |
| Footer | `Apply only (no regeneration)` 44 px secondary; `Apply and regenerate` 44 px primary **disabled** |

```
+---------------------------------------------------------------------------------------+
| Change aspect ratio  9:16 -> 4:5                                          (unsaved)    |
+---------------------------------------------------------------------------------------+
| becomes stale                                                                         |
|   o composition (17 scenes)                                                           |
|   o render (1 pass)                                                                   |
| images                                                                                |
|   +---------------------------------------------------------------------------------+ |
|   | pending reframe check (local, no provider call) .................. [checking]    | |
|   | if reframeable:      0 image calls, 17 images survive (reframed)                | |
|   | if not reframeable:  17 image calls, 0 images survive                           | |
|   +---------------------------------------------------------------------------------+ |
| narration: survives (79.1 s)                                                          |
|                                                                                       |
| [ Apply only (no regeneration) ]        [ Apply and regenerate ]      (disabled until|
|                                                                        check resolves)|
+---------------------------------------------------------------------------------------+
```

**States.** Checking (as shown; regenerate disabled, apply enabled); reframeable (`Images survive: 17 reframed, 0 image calls`); not reframeable (`17 image calls; 0 images survive` with the regenerate button enabled); check failed (`The reframe check could not complete. Regeneration stays disabled until it can be computed.` + `Retry check`); nothing to invalidate (`No assets exist yet — this edit costs nothing to apply.`).
**Notes.** This is the only conditional in the matrix and it is resolved **before** any spend. Both outcomes are stated while checking, so the operator can decide whether to wait. No currency appears; the numbers are image calls and render passes only.

---

### 6.9 W-08 — Failure recovery / retry scope (IP-06)

**Trace.** W-08, IP-06, C-17/C-18/C-19/C-20, AX-25, R-011-2/3, R-012-2/4, R-022-2. **Milestone A.**

| Region | Measurement |
|---|---|
| Panel | 560 px (in S-08 an overlay drawer 560 px; in S-15 the right column). Padding 20 |
| Header | 24 + 4×20 key/value rows, 12 px mono values, label column 132 px |
| Will re-run | 3 rows 24 px, mono dotted leader, quantity right-aligned |
| Will not re-run | 1 wrapping line + guarantee callout (info, 16 px padding) |
| Conditional callouts | `unknown charge` amber, `idempotency-unprotected` amber, 8 px apart |
| Footer | `Cancel` 44 px secondary (initial focus) + `Retry narration · 1 TTS call` 44 px primary |

```
+---------------------------------------------------------------------------------------+
| Video 18 . stage NA (narration) . FAILED                                              |
| provider      ElevenLabs . eleven_multilingual_v2                                     |
| request id    req_8f21                                                                |
| error class   transient . HTTP 503                                                    |
| attempts      3 of 3 . backoff used 1 s, 4 s, 16 s                                    |
+---------------------------------------------------------------------------------------+
| WILL RE-RUN                                                                           |
|   narration ............................................ 1 TTS call                   |
|   timing ................................... derived from new alignment               |
|   render ........................................................... 1 pass            |
| WILL NOT RE-RUN (stored, reused)                                                      |
|   17 images (v13) . script rev 4 approved . storyboard 17 scenes . 5 sources          |
|   (!) Retrying reuses every stored asset: no new provider call is made for a          |
|       completed stage.                                                                |
|   [WARN] Attempt 3 timed out at 60 s and may have been billed. It is recorded as      |
|          unknown charge - not as unbilled.                                            |
+---------------------------------------------------------------------------------------+
|                           [ Cancel ]   [ Retry narration  (1 TTS call) ]              |
+---------------------------------------------------------------------------------------+
```

**States.** Five variants of UC-13 (transient-with-attempts, transient-exhausted, non-retryable, unknown-charge, idempotency-unprotected) plus the restart summary. Retrying: `Retrying… attempt 1 of 3 · next backoff 4 s`. Success: the stage chip flips to `running` then `done` and the drawer closes with focus back on the failed row.
**Notes.** The six questions of AX-25 are answered in order, in the panel: what failed, at which stage, what class, attempts used, what survived, what a retry re-runs — and a seventh line gives the next operator action. Focus starts on Cancel (AX-04). The panel never says "unbilled" for a timeout.

---

### 6.10 W-09 — Failures and health, degraded (S-19)

**Trace.** W-09, S-19, IP-07, IP-08, R-018-1/2/3, R-008-3, R-025, D2. **Milestone A (providers + attempts) / B (full).**

| Region | Measurement |
|---|---|
| Degraded banner | Full width, 4 px amber left border, 16 px padding, 4 lines of 13/20 |
| Status rows | Definition list, label column 132 px, values 12 px mono, rows 28 px |
| Provider grid | 2×2 blocks 240×56, each: provider name, state word, last-ok time, failure count |
| Qualification | 4 chips in a row: `PASS 2026-10-20` (success) / `NOT RUN` (not run) |
| Queue / disk | 28 px rows with a 2 px progress meter for disk and a `preview cleanup →` link |
| Attempt table | `attempts` variant of UC-17, 36 px rows, 50 per page, no totals |

```
+---------------------------------------------------------------------------------------+
| Health                                                                                |
| +-----------------------------------------------------------------------------------+ |
| | [WARN] DEGRADED  database unreachable since 14:02 UTC                             | |
| | blocked: new batches (HTTP 503 on /ready)                                          | |
| | still works: login, review, downloads of stored assets                             | |
| | system: re-checking every 5 s; self-heals within 30 s of DB ready                  | |
| +-----------------------------------------------------------------------------------+ |
| providers      text ok (14:01)     image 3x 503 since 14:02                          |
|                tts ok              research ok                                       |
| qualification  image PASS 2026-10-20 . tts PASS . text PASS . research PASS           |
| queue          render 6 waiting (1 concurrent, default) . images 8 queued             |
| disk           91% full . 1.8 GB free . [preview cleanup ->]                          |
| attempt rows   [last 50]  provider . model . prompt hash . req id .                   |
|                billed_units (debug) . idempotency . charge        no totals (D2)      |
+---------------------------------------------------------------------------------------+
```

**States.** Fresh install (`all providers present`, qualification `not run`); loading (status rows skeleton, attempt table skeleton); partial (one provider times out: `unknown, last seen 13:40` — itself a health finding); probe error (shown as a health finding, not a generic error); degraded (as rendered); recovered (banner clears, one polite announcement, banner does not linger).
**Notes.** The banner answers all five of IP-07's questions in order. `billed_units (debug)` is the only place a billing unit appears, it is per-row, and there is no sum, average, export or chart anywhere (IP-08, D2). Disk uses binary units to one decimal (1.8 GB) per §8.3.

---

### 6.11 W-10 — Batch export with integrity panel (S-17)

**Trace.** W-10, S-17, IP-12, R-014-2/3/4, R-015-5, C-23, OQ-5. **Milestone B.**

| Region | Measurement |
|---|---|
| Header | 56 px: title `Batch export 2026-10-20-a` 24/32 + integrity chip; eligibility line 13 px mono |
| Integrity panel | 560 px card, padding 20; five check rows 24 px with dotted leaders and right-aligned results |
| Column preview | 12 px mono, wraps to 2 lines, `--surface-inset`, padding 8 12 |
| Posting-order list (OQ-5) | 44 px rows, 32 px drag handle, `#`, filename, title, posted flag |
| Footer | 40 px: `Export ZIP · 29 videos` 44 px primary; `Fix #18 first` 32 px secondary |

```
+---------------------------------------------------------------------------------------+
| Batch export  2026-10-20-a                              [CHECK integrity ok]           |
| eligible 29 . excluded 1 (#18 FAILED: narration - retry to include)                   |
+---------------------------------------------------------------------------------------+
| manifest.csv check                                                                    |
|   rows = videos ............................ 29   ok                                  |
|   posting_order 1..N unique ................ 1..29 ok                                 |
|   filenames unique .......................... ok                                      |
|   referenced files present .................. 29/29 ok                                |
|   secrets scan .............................. 0 matches                               |
| columns: posting_order, filename, title, srt, vtt, sidecar, duration_s, posted_flag    |
+---------------------------------------------------------------------------------------+
| privacy: no API keys or secrets in any file in this ZIP                               |
|                          [ Fix #18 first ]   [ Export ZIP  (29 videos) ]              |
+---------------------------------------------------------------------------------------+
```

**States.** No eligible videos (`Nothing to export yet — 30 videos need final approval`); building (`Building ZIP… 29 of 29 files` + per-region bar); blocked by integrity failure (the failing check row turns danger, the button becomes `Export blocked` + reason, C-23); build failure (`ZIP build failed at <step>. Nothing was downloaded.`); some excluded (exclusion row with reason, eligible count recomputed); re-export after posting (`posted_flag=1` shown per row, order unchanged for the rest — R-014-4).
**Notes.** Integrity is proven before download; the download button names the problem instead of producing a broken ZIP. Posting order is editable by drag or `Alt+↑/↓` (OQ-5 default) and the check re-runs on every change. The ZIP is the only place a filename appears — the UI never invents one.

## 7. Responsive rules

Desktop-first: the review loop is image-heavy and the product's job is judging 17 images and a 1080×1920 frame. Four bands, each with a stated capability ceiling rather than a vague "stacks".

### 7.1 Bands and capability

| Band | Name | What is available | What is not |
|---|---|---|---|
| **≥1440** | Full workbench | Everything. 216 px rail, 360 px inline impact column, 6-column scene grid, 8-column batch table, 2-column form, full 11-node rail with words | — |
| **1024–1439** | Compressed workbench | Everything, with: 64 px icon rail (labels become accessible names + tooltips), 20 px content padding, 320 px impact column, 4-column scene grid, batch table drops the `Pins` column (pin moves into the attention cell as a mono suffix), claims table drops the source title (domain only), dialogs `max-width: 90vw` | Nothing is removed from the workflow |
| **768–1023** | Review-lite | Batch status, video status, script text and claims, QC numbers, render preview (scaled to 320 px wide), **and approvals**. Single column; the impact panel sits directly above its commit buttons; the stage rail scrolls horizontally | The 17-tile grid, scene replace, scene reorder, batch export ZIP and posting log. Each is replaced by a line naming the width requirement: `Open at 1024 px or wider to replace a scene image.` |
| **≤767** | Monitoring (read-only) | Overview, batch status, video status, pins, failures **read-only**, downloads of already-built packages. Card list instead of table | Every gate approval, replace, reorder, retry, delete, cleanup, posting-record edit. Each unavailable control is absent (not disabled) and replaced by one line: `Approvals need a screen 1024 px or wider. This view is monitoring only.` (AX-22, DI-09) |
| **≤480** | Phone | The ≤767 set, plus a 16 px page padding and a single-column card stack; reading surfaces reflow at 320 px with no horizontal scroll (AX-14) | Same as ≤767 |

**Reading of AX-22.** AX-22 forbids gate approval *below 768 px* and calls ≤480 "monitoring-only". Both are honoured: every width under 768 is read-only, and 768–1023 is the minimal approval view. The 768–1023 band is more capable than AX-22's floor (it allows approvals) and less capable than a desktop (no image judging); this is the one place where the implementation deliberately narrows the desktop workflow, and it is raised in §12 C-4 for confirmation.

### 7.2 Per-surface behaviour

| Surface | ≥1440 | 1024–1439 | 768–1023 | ≤767 |
|---|---|---|---|---|
| Left rail | 216 px, labels + badge | 64 px, icon + accessible name | Hidden; 44 px top bar with back link and `Attention (4)` | Same as 768 |
| Status strip | Full sentence | Full sentence | Service word only + degraded icon that still carries text | Service word only |
| Workspace grid | `1fr / 360`, gap 24 | `1fr / 320`, gap 16 | Single column: content, then impact panel, then commit buttons | Same, but the impact panel collapses to a summary link (no editing below 768) |
| Stage rail | 11 nodes, words + pins | 11 nodes, words + pins, 44 px min | Horizontal scroll, code + state glyph, words in accessible name | Read-only strip, codes only |
| Scene grid | 6 columns × 168 | 4 columns × 168 | Replaced by a one-scene pager (280 px thumb, `←`/`→`, `S03 of 17`) with no replace control | Replaced by a vertical list of scene rows with a 72 px thumb and state chip |
| Batch table | 8 columns | 7 columns (pins merged) | Card list: `#7 · title · state chip · reason · 2 min` in 3 lines, 88 px per card | Same cards, 2 lines, 80 px |
| Claims table | 4 columns | 4 columns, source title hidden | 3 columns, actions collapse into an overflow menu | Read-only rows |
| Export integrity | Panel 560 | Panel fluid | Full-width panel, checks stack with the result on a second line | Read-only summary + `Download already-built ZIP` if one exists |
| Dialog | 640 / 960 px | 90vw | Full-screen sheet, 20 px padding | Full-screen sheet, footer buttons stacked 44 px |
| Toasts | bottom-right 24 | bottom-right 16 | bottom 16, full width minus 32 | bottom 16, full width minus 32 |

### 7.3 Rules that hold in every band

1. **No horizontal page scroll** at any width. Tables may scroll inside their own container with a visible `overflow-x` indicator; the page never does (AX-14).
2. **The primary action never moves into a hidden menu.** If a band cannot offer an action, it says so in place and names the width that can.
3. **Text reflows, labels do not truncate to ambiguity.** Titles truncate with a full-title tooltip and full accessible name; state words never truncate.
4. **Zoom 200%** is treated as a width of `viewport / 2`: at 1440 with 200% zoom the app renders the 768–1023 band. That is why every band must be a working, honest surface and not a degraded skeleton.
5. **Nothing is hidden by hover-only.** Tooltips supplement, never substitute (this is why the compact rail keeps accessible names and why state words survive to 1024).

---

## 8. Accessibility implementation

Target **WCAG 2.2 AA** on the review loop (UX §7). This section converts AX-01…AX-28 into decisions an implementer can build and QA can test.

### 8.1 AX-01…AX-28 → concrete UI decisions

| ID | Requirement (short) | UI decision | Where implemented | QA test |
|---|---|---|---|---|
| AX-01 | Whole review loop keyboard-only | Every control is a native button/link/input; shortcuts are additive; no drag-only action (reorder has `Alt+↑/↓`); no hover-only control | §5 all components; §8.4 orders | F-A with the mouse unplugged; zero dead ends |
| AX-02 | Logical focus order = visual order | DOM order is visual order on S-10 (status → budget → editor → claims → approval → impact), S-12 (header → grid row-major → selection bar) and S-08 (header → group → rows) | §8.4 | Tab audit with the accessibility tree open |
| AX-03 | No browser/AT shortcut conflicts | Single-key shortcuts (`j k r a g [ ] f`) are bound only when `document.activeElement` is not an input, textarea, select or `[contenteditable]`; `Alt+`-prefixed shortcuts are used where a bare key would conflict | UC-07, UC-10, UC-11 | Type `j r a` in the script editor: characters appear, nothing navigates |
| AX-04 | Spend action never default focus / bare Enter | Initial focus: *Apply edit* (UC-06), *Cancel* (UC-13), *Cancel* (UC-15), video title link (row menus). No spend control is ever `autofocus`, and `Enter` on a focused non-spend control never triggers a spend | UC-06, UC-13, UC-15, UC-18 | Open each spend surface; assert focus; press Enter once; assert nothing was spent |
| AX-05 | Reorder without drag | `Alt+↑/↓` on the selected tile; live announcement `S05 moved to position 3 of 17…`; the drag handle is never the only affordance | UC-07, UC-10 | Reorder two scenes with the keyboard only |
| AX-06 | Focus never moves on background update | Progress updates write to a live region only; no re-render replaces the focused node (list keys are stable); the batch table patches cells, it does not re-mount rows | UC-11, UC-23 | Focus in the editor for 5 min during a 30-video batch; focus unchanged |
| AX-07 | Focus to status region on regeneration, back on settle | On trigger: focus moves to the stage status element (`tabindex="-1"`, `role="status"`, label `scene 7 image — generating, attempt 1 of 3`). On settle: focus returns to the triggering button, which is kept in the DOM (disabled while running, never removed) | UC-09, UC-13 | Replace a scene; watch focus land and return |
| AX-08 | Gate announcement names video, gate and count | Template: `Video 7 of 30 needs script approval. 4 videos need attention.` — one polite announcement, no generic wording | UC-23 | Trigger a gate; assert exact string |
| AX-09 | Dialogs trap focus, Esc, return focus | `role="dialog" aria-modal="true"`, focus trap on the first/last focusable, Esc cancels, focus restored to the opener; scrim click disabled for destructive dialogs | UC-21 | Tab through a dialog 3×; Esc; assert focus returned |
| AX-10 | Progress announced as debounced summary | One polite region, max 1 message / 5 s, content `18 of 30 complete. 3 need attention.`; per-row and per-tile changes are never announced | UC-11, UC-23 | Count announcements in a 1-minute run; ≤12 |
| AX-11 | Disabled control exposes its reason as text | The reason is a visible element with an `id`, referenced by `aria-describedby` on the disabled button; the button keeps `aria-disabled="true"` and is focusable so the description is reachable | UC-18, UC-19, §6.6 | Focus *Approve script*; screen reader reads `3 of 14 factual claims have no resolvable source` |
| AX-12 | Contrast thresholds | 52 measured pairs, 0 failures (§8.2). Body ≥4.5, boundaries ≥3.0 | §2.1, `tools/contrast_audit.py` | Re-run the audit in CI |
| AX-13 | State never colour-only | Four channels: colour + glyph + word + border structure (§3). Every chip has a word | §3, UC-04 | Greyscale screenshot of S-08 and the rail; identify all 8 |
| AX-14 | Reflow at 320 px, 200% zoom | No horizontal page scroll; cards below 768; tables scroll internally; 200% zoom maps to the next band down (§7.3.4) | §7 | 320 px viewport and 200% zoom on S-02/S-08/S-10 |
| AX-15 | Images and video have accessible names | Scene `<img alt>` = prompt summary (140 chars); render `<video>` has a text alternative `1080×1920, 30 fps, 75.2 seconds, captions available` plus a `<track kind="captions">`; audio has a transcript link | UC-08, §6.9/S-15 | Screen-reader pass on S-12 and S-15 |
| AX-16 | Motion respects reduced-motion, no autoplay audio | `prefers-reduced-motion` collapses durations, freezes previews to a static frame, stops the spinner rotation; render preview never autoplays with sound and never autoplays at all without a click | §2.7, UC-08 | Enable reduced motion; previews static; no audio |
| AX-17 | Target sizes | All targets ≥24×24; approve/replace/retry/release/export/download/mark-posted ≥44×44 with ≥8 px separation | §2.8, UC-18 | Measure with the inspector on S-12 and UC-13 |
| AX-18 | Focus indicator ≥3:1, ≥2 px | 2 px `#7EA6F8` outline + 2 px offset; 7.36:1 on panel, 5.50:1 on selected rows; inset variant on table rows | §2.8 | High-contrast keyboard pass |
| AX-19 | Every number exact and sourced | All counts come from the document; the only approximations are the labelled indicatives of UX §0.4 (`~17 s`, `≈5 min`, `indicative`) and they carry the label inline; banned words (`some`, `several`, `a few`, `approximately`) appear only inside this specification, never in product copy | §9, UC-24 | Copy audit against §9 |
| AX-20 | One wording per state/fact | One string table (§9); `stale`, `failed`, `blocked` and the eight state words are not varied by screen | §9 | Cross-screen string diff |
| AX-21 | Unsaved edits never lost | Draft persisted per document revision to local storage + server draft; restored with a banner `Unsaved changes from 14:12 UTC restored.` after refresh, session expiry or a 409; never discarded automatically | UC-19, IP-09, S-01 | Kill the session mid-edit; re-login; text intact |
| AX-22 | Phone ≤480 monitoring-only, no gates <768 | ≤767 is read-only, and every unavailable gate is absent with a line naming the width (§7.1) | §7 | 390 px viewport: attempt each gate, none available |
| AX-23 | Destructive actions need typed/two-step confirm | Typed confirm for delete assets (`delete`) and cancel batch (`cancel batch`); two-step for regenerate-over-approved; single confirm with Cancel focused for archive/discard; never reachable by one Enter from a list | UC-21, IP-14 | Single-Enter delete: impossible |
| AX-24 | Long operations cancellable/abandonable; leaving does not cancel | Every running surface states `Leaving this page does not stop the job.`; a batch cancel is explicit and warns that in-flight calls cannot be aborted | UC-11, UC-23, IP-14 | Navigate away mid-render; job continues |
| AX-25 | Failure surface answers six questions | UC-13 renders all six in a fixed order, plus a next-action line; S-19 repeats them for provider-wide failures | UC-13, §6.10 | Audit every failure surface against the six |
| AX-26 | Never claim a timeout was unbilled | The string `unknown charge` is a component variant of the attempt row and of UC-13; the words `unbilled` / `free` are banned in timeout contexts | UC-13, UC-17 | Force a TTS timeout; row says unknown charge |
| AX-27 | Counters within 5 s, stalled feed labelled | Server-sent events (or 2 s polling) update counters; `last update 2 s ago` ticker; at >20 s the header switches to `progress feed delayed — last update 22 s ago` and the count is marked stale | UC-11, UC-23 | Change a state; measure; stop the feed; read the label |
| AX-28 | No blocking full-screen spinner | Loading is per region: skeleton rows/panels keep their geometry, progress is a 2 px in-region meter, the rest of the screen stays operable | §5, §7 | Start a 30-video batch; all review surfaces usable |

### 8.2 Measured contrast (AX-12)

Full run: **52 pairs, 0 failures** (`tools/contrast_audit.txt`). The pairs that matter most:

| Pair | Measured | Threshold |
|---|---|---|
| `text-primary` on `surface-app` / `panel` / `raised` / `hover` / `selected` | 15.93 / 14.88 / 13.67 / 12.56 / 11.11 | 4.5 |
| `text-secondary` on `surface-panel` / `raised` / `hover` / `selected` | 8.78 / 8.07 / 7.41 / 6.56 | 4.5 |
| `text-tertiary` on `surface-panel` / `raised` / `app` | 5.86 / 5.39 / 6.28 | 4.5 |
| `text-link` on `surface-panel` / `app` | 9.24 / 9.89 | 4.5 |
| `accent` / `success` / `warning` / `danger` / `stale` / `running` / `cancelled` on `surface-panel` | 7.36 / 7.82 / 8.28 / 7.05 / 8.17 / 9.76 / 5.86 | 4.5 |
| Same seven on `surface-raised` | 6.77 / 7.18 / 7.61 / 6.48 / 7.51 / 8.97 / 5.39 | 4.5 |
| `border-default` on `surface-panel` / `app` (control boundary) | 3.75 / 4.02 | 3.0 |
| `border-strong` on `surface-panel` | 5.86 | 3.0 |
| Focus ring `accent` on panel / app / selected row | 7.36 / 7.89 / 5.50 | 3.0 |
| `#FFFFFF` on `accent-fill` / hover | 5.72 / 4.77 | 4.5 |
| `#FFFFFF` on `danger-fill` / hover | 5.62 / 4.83 | 4.5 |
| `text-primary` on `control-fill` (secondary button) | 12.56 | 4.5 |
| `accent-fill` / `danger-fill` against panel (button silhouette) | 3.11 / 3.16 | 3.0 |
| `text-primary` on `stale-tint` / `danger-tint` / `warning-tint` | 12.44 / 12.85 / 12.44 | 4.5 |
| `stale` / `danger` / `warning` against their tints (edge indicators) | 6.83 / 6.09 / 6.92 | 3.0 |

Two declared exemptions, both deliberate and both documented rather than hidden: `text-disabled` (3.15:1 on panel, 2.90:1 on raised) is exempt under WCAG 1.4.3's inactive-control exception, and `border-subtle` (1.28:1) is decorative only — no interactive boundary, state indicator or focus ring uses it, which is exactly why `border-default` exists at 3.75:1. The chips' hatch and dashed patterns are also non-text state indicators and are measured against their tints above.

### 8.3 Focus ring and target sizes

```
:focus-visible {
  outline: 2px solid var(--accent);   /* #7EA6F8 */
  outline-offset: 2px;
  border-radius: inherit;
}
.tbl tbody tr:focus-visible { outline-offset: -1px; }   /* not clipped by the table edge */
.tile:focus-visible        { outline-offset: 2px; }     /* inside the clip via overflow: clip on the grid */
```

The ring is never suppressed, never animated, and never replaced by a background change. Minimum target 24×24; the ten review-critical controls (approve script, approve final, replace, retry, release remaining, export ZIP, download package, mark posted, acknowledge claim, cancel batch confirm) are 44×44 with ≥8 px separation.

### 8.4 Keyboard order per screen

| Screen | Order |
|---|---|
| S-01 Login | Skip link → Username → Password → show/hide → Sign in → (error, announced) |
| S-02 Overview | Skip link → rail (Overview…Settings) → *Review next needing attention* → attention rows (row = one stop; `→` opens) → batch group links → footer |
| S-08 Batch | Skip link → rail → counter actions (*Review next* / filter group) → table rows (`↑/↓`, `Enter` opens, `r` retry scope on failed rows only) → failed row's *Retry scope* → footer links |
| S-10 Script | Skip link → rail → stage rail (one stop, `←/→`) → tabs → status bar (*Approve*) → budget (non-interactive) → editor fields → claims table (row → actions) → **impact panel** → *Apply edit* → *Apply and regenerate* |
| S-12 Scenes | Skip link → rail → stage rail → tabs → *Release remaining 14* → grid (`j/k` or arrows, `Enter`, `r`, `Alt+↑/↓`) → selection bar (*Replace*, `↑`, `↓`) |
| S-13 Scene detail | Skip link → rail → stage rail → tabs → compare frames (`←/→` between attempts) → *Edit prompt* → *Replace image* → provenance disclosure → close |
| S-15 Render | Skip link → rail → stage rail → tabs → render player (play/pause, captions toggle) → QC list (read-only) → *Approve final* → *Return to stage* |
| S-19 Health | Skip link → rail → degraded banner link → provider blocks → qualification → queue → disk → *preview cleanup* → attempt table (rows) |
| Dialogs | First focusable is Cancel/close (destructive) or the title container (informational); Tab cycles inside; Esc cancels; focus returns to the opener |

### 8.5 Announcement strategy

| Event | Region | Politeness | Message |
|---|---|---|---|
| Gate opens | `#live-status` | polite | `Video 7 of 30 needs script approval. 4 videos need attention.` |
| Progress change | `#live-status` | polite, debounced ≤1/5 s | `18 of 30 complete. 3 need attention.` |
| Stage settles after the operator's action | `#live-status` | polite | `Scene 7 image done. 1 of 17 replaced. Render is stale.` |
| Regeneration starts | focus move + `#live-status` | polite | `Scene 7 image — generating, attempt 1 of 3.` |
| Failure needing action | `#live-status` (row already in the table) | polite | `Video 18 failed at narration. 3 of 3 attempts used. Open retry scope.` |
| Degraded transition | `#live-alert` | assertive | `Service degraded — database unreachable. New batches are rejected; review and downloads still work.` |
| Session expired | `#live-alert` | assertive | `Your session expired. Your draft is preserved. Sign in to continue.` |
| Destructive confirm result | `#live-status` | polite | `Batch cancelled. 18 videos remain approved and exportable; 12 are excluded.` |

Rules: no announcement for routine stage completions that the operator did not trigger (they appear in the table silently); no announcement while focus is inside a text field **unless** it is the operator's own action; the two regions are emptied after 10 s so repeated identical messages are re-announced; nothing is announced that is not also visible on screen.

### 8.6 Accessibility items I could not fully satisfy in a visual specification

1. **AX-21 (unsaved edits never lost)** and **AX-24 (leaving does not cancel)** are behavioural guarantees. The spec defines the banner, the restore point and the copy, but only implementation and QA can prove them.
2. **AX-27 (≤5 s freshness, stalled-feed label)** depends on a transport decision (SSE vs polling). The visual design assumes server-pushed updates and specifies the stalled label, but cannot guarantee the timing.
3. **AX-15 (captions track on the render preview)** requires the render to expose `.srt`/`.vtt` to the `<video>` element; the UI provides the track element and the text alternative, not the files.
4. **AX-14 at 200% zoom on the 30-row table** cannot be satisfied while keeping all 8 columns at 1440 (see §12 C-1). The design's answer is column priority + the next band, which needs a ruling.
5. **AX-27/AX-10 announcement rate** under bursty failure (5 videos failing in 5 s) can only be kept ≤1/5 s by coalescing messages into one summary. The spec mandates coalescing; the exact summarisation string for mixed failures is an implementation detail flagged in §10.3.

## 9. Content and microcopy

### 9.1 Rules

1. **Two buttons, named by outcome.** `Apply edit (no regeneration)` / `Apply and regenerate now`. Never `OK` / `Cancel` on a spend decision (UX §8.1.3). `Cancel` survives only where nothing is spent.
2. **Numbers first, nouns second.** `17 image calls`, not `several image calls`. The count comes from the current document (AX-19).
3. **Name what survives.** No warning lists only losses.
4. **No currency, no credits, no totals, no "budget" as money.** Call counts are the only quantity in a spend warning (D2).
5. **Never assert an unverified billing fact.** `unknown charge` for any timeout (R-012-4, AX-26).
6. **Banned strings, product-wide:** `Something went wrong`, `Oops`, `An error occurred`, `Please try again later` (without a cause and a next step), `Are you sure?` (without the consequence), `Invalid input` (without the field), `AI-generated` as a risk disclaimer, `publish`, `post to <platform>`, `connect account`, `upgrade`, `credits remaining`, `out of credits`, `$`, `USD`, `cost`, `price`.
7. **One word per state** (AX-20): `not run`, `running`, `done`, `awaiting approval`, `stale`, `failed`, `blocked`, `cancelled`. Never `outdated`, `needs refresh`, `error`, `pending`, `queued` as a state word (a queue is an attention reason: `waiting: render slot`).

### 9.2 Buttons

| Label (exact) | Where | Variant / size |
|---|---|---|
| `Sign in` | S-01 | primary / 44 |
| `Create series` | S-02 empty, S-03 empty | primary / 44 |
| `Create batch` | S-07 | primary / 44 |
| `Review next needing attention →` | S-02, S-08 | secondary / 32 |
| `Approve script` | S-10 | primary / 44; disabled with described reason while claims unresolved |
| `Approve final` | S-15 | primary / 44; disabled while QC fails |
| `Apply edit (no regeneration)` | UC-06, S-10/S-11/S-12/S-13 | secondary / 44 — **default focus** |
| `Apply and regenerate now` | UC-06 | primary / 44 — never default focus |
| `Apply only (no regeneration)` | W-07 conditional case | secondary / 44 |
| `Release remaining 14` (sub: `14 image calls`) | S-12 checkpoint | primary / 44 |
| `Fix scenes 1–3 first` | S-12 checkpoint | secondary / 32 |
| `Replace image` (sub: `1 image call`) | S-13, tile bar | secondary / 44 |
| `Retry narration` (sub: `1 TTS call`) | UC-13 | primary / 44 |
| `Retry now` | UC-13 transient with attempts left | secondary / 32 |
| `Cancel` | UC-13, UC-15, dialogs | secondary / 44 — **default focus** |
| `Acknowledge claim` | UC-15 | primary / 32 |
| `Attach source` / `Reword as non-factual` / `Acknowledge as unsourced` | claim row | quiet / 32 |
| `Export ZIP` (sub: `29 videos`) | S-17 | primary / 44 |
| `Fix #18 first` | S-17 | secondary / 32 |
| `Download package` (sub: `5 files, 41.2 MB`) | S-16 | primary / 44 |
| `Mark as posted (manual upload)` | S-18 | primary / 44 — never the words "publish" or "post to" |
| `Accept staleness` | stale ribbon | quiet / 32, two-step confirm |
| `Cancel batch` | S-08, typed confirm | danger / 44 |
| `Delete assets` | S-20, typed confirm | danger / 44 |
| `Open` / `Retry scope` / `Open source` | table rows | quiet / 28 |

### 9.3 Empty, first-run and blocked lines

| Situation | Exact string |
|---|---|
| S-02 first run | `No series yet. No batches yet.` + `Create series` + `Three provider keys are checked in Settings.` |
| S-03 empty | `No series yet.` + `Create series` |
| S-05 only v1 | `Only v1 exists. Later edits appear here.` |
| S-07 before a version resolves | `The series version is still resolving — creating is disabled until it is known.` |
| S-09 no topic (A) | `No topic yet. Enter the topic to begin this video.` |
| S-09 no topic (B) | `No topic yet. Propose one, or enter your own.` |
| S-10 before topic approval | `No script yet. Approve the topic to start the script.` |
| S-11 before script approval | `No storyboard yet. Approve the script first.` |
| S-12 0 of 17 | `0 of 17 generated. Images are blocked until the script is approved.` |
| S-12 no recurring character | `Protagonist checkpoint not applicable — this series has no recurring character.` |
| S-14 before narration | `No narration yet. It runs after script approval.` |
| S-15 before render | `No render yet. It runs after narration and timing.` |
| S-16 not eligible | `Not eligible for export. Final approval is required first.` |
| S-17 no eligible videos | `Nothing to export yet — 30 videos need final approval.` |
| S-18 empty | `Nothing marked posted yet. Posting is manual; record it here afterwards.` |
| S-20 nothing past retention | `Nothing is past retention.` |
| S-21 absent keys | `2 of 3 keys present. Absent: ELEVENLABS_API_KEY. Set it in .env and restart.` |
| <768 band, approval attempted | `Approvals need a screen 1024 px or wider. This view is monitoring only.` |
| <1024 band, replace attempted | `Open at 1024 px or wider to replace a scene image.` |

### 9.4 The 25 templates, bound to their controls

| ID | Exact string (from UX §8.2) | Rendered by |
|---|---|---|
| C-01 | Changing the script makes **scene prompts (17), narration (1 TTS call), timing and captions, and the render (1 pass)** stale. **17 stored images survive** — a wording-only edit does not regenerate images. Text calls: 17 prompts re-derived. | UC-06, ready state (script edit) |
| C-02 | Replacing scene 7's image costs **1 image call**. Scene 7's visual and the render become stale. **Images 1–6 and 8–17 and the narration survive.** | UC-09 → UC-06 scoped |
| C-03 | Reordering changes captions and timing, and makes the render stale. **0 image calls. 0 TTS calls. 17 images and the narration survive.** Scene ids stay S01–S17. | UC-10 commit line |
| C-04 | Changing the voice or speed makes **narration (1 TTS call), timing and the render** stale. **17 images survive.** | UC-06 (voice/speed variant) |
| C-05 | Composition and the render become stale. Images: **pending reframe check** — 17 calls only if the current images cannot be reframed. The regenerate action stays disabled until that is known. | UC-06 conditional state, W-07 |
| C-06 | Changing the topic makes **the script and everything downstream** stale: script, storyboard, narration (1 TTS call), timing, render. **No image call is made until you approve the new script.** | UC-06 (topic-after-research variant) |
| C-07 | The impact of this change could not be computed, so regeneration is blocked. Editing and regeneration are both disabled until it can be computed — this prevents a change whose cost you could not see. | UC-06 failed state |
| C-08 | Saving mints **v14**. Nothing is regenerated. 30 videos keep their current pins; stages that have not started will use v14 when they start. v13 stays immutable. | S-04 commit panel (IP-02) |
| C-09 | Approving the script unlocks **17 image calls and 1 TTS call** for this video. Nothing runs until you approve. | S-10 approval confirmation |
| C-10 | Script approval is blocked: **3 of 14 factual claims have no resolvable source.** Source, reword or acknowledge all 3 first. | S-10 approval block + approve button description |
| C-11 | 228 words → about 75.1 s at the measured 3.035 words/s. Band for a 75 s target: 216–239 words. Outside the band, narration will most likely miss the ±5% duration check and return here after one TTS call. | S-10 word-budget bar (see §12 C-2 on the word "about") |
| C-12 | Service not ready — the database is unreachable. New batches are rejected (HTTP 503). Review and downloads of stored assets still work. Re-checking every 5 s; recovers within 30 s of the database reporting ready. | UC-23 degraded-db banner; S-07 blocked |
| C-13 | The image provider has failed 3 times in a row since 14:02 UTC. 30 videos are paused at the image stage; other stages continue. Automatic retries use 1 s, 4 s and 16 s, then stop and wait for you. | UC-23 provider-down banner |
| C-14 | Disk is 91% full (1.8 GB free). Renders and new image downloads will fail below the safety margin. Cleanup preview: **412 assets, 6.2 GB** eligible, 38 protected. No new media writes until space is freed. | UC-23 disk banner; S-20 entry |
| C-15 | Image rate limit reached (10 requests per minute). **8 calls queued** — this is expected, not an error. | Row attention reason + S-19 queue line |
| C-16 | Startup blocked: missing required configuration `ELEVENLABS_API_KEY`. Set it in `.env` and restart the stack. Other services are not started. | SY-1 full page |
| C-17 | Retry will re-run **narration (1 TTS call), timing and the render (1 pass)**. It will **not** re-run the 17 images, the approved script, the storyboard or the research. Retrying reuses every stored asset: no new provider call is made for a completed stage. | UC-13 body |
| C-18 | This attempt timed out at 60 s. It may have been billed. It is recorded as **unknown charge** — not as unbilled. | UC-13 + attempt row callout |
| C-19 | Not retryable: HTTP 401 from ElevenLabs. Retrying fails the same way. Fix the key in Settings, then retry. | UC-13 non-retryable variant |
| C-20 | `<Stage>` failed for video `<n>`: `<error class>`, `<HTTP status>` from `<provider>`, attempt `<a>` of 3. `<What survived>`. `<What a retry re-runs>`. | S-19 failure row summary; `role="status"` message |
| C-21 | Rejected: 0.91 similar to video 4, 'Why We Procrastinate' (threshold 0.85). The same rule applies to the last 10 videos of this series. Use it anyway, or propose another topic. | S-09 dedupe block (IP-11) |
| C-22 | 18 of 30 complete · 3 need attention · 9 running · 1 failed. Last update 2 s ago. | S-08 header |
| C-23 | The ZIP was not built. `manifest.csv` has posting_order 7 twice; every row must have a unique integer 1..29. Nothing was downloaded. | UC-16 blocked state |
| C-24 | Posted on `<platform>` at 2026-10-20T16:04:00Z — `<url>`. This sets `posted_flag=1` in the next export. Posting itself is manual; this product does not publish. | S-18 confirmation line |
| C-25 | 412 assets, 6.2 GB, oldest 2025-10-20. 38 assets are protected because their project is unposted, and 6 because a batch is in flight. Deleting is permanent. | S-20 preview + typed confirm restatement |

### 9.5 Additional strings authored in this document (each traced)

| Context | String | Trace |
|---|---|---|
| Login failure | `Wrong username or password` | R-015-1…4: same message for both fields, no enumeration |
| Login throttled | `Too many attempts. Try again in 30 s.` | R-015; rate limiting is implementation, the string is UI |
| Session expiry | `Your session expired. Your saved draft is preserved.` | SY-2, AX-21 |
| Unsaved draft restored | `Unsaved changes from 14:12 UTC restored.` | AX-21 |
| 409 conflict banner | `This script was saved by another tab at 14:12 UTC (revision 5). Your revision 4 was not saved. Nothing was overwritten.` | IP-09, R-024-2 (verbatim from UX IP-09) |
| 8-gram pass | `8-gram scan: PASS — no run of 8 or more words matches the 2 stored references.` | R-003-2 |
| 8-gram fail | `8-gram scan: FAIL — a run of 8 or more words matches reference 2. Reword before approval.` | R-003-2 |
| Batch target invalid | `Batch target must be an integer from 1 to 30.` | R-019-1 |
| Duration invalid | `Hard cap is 180 s. Recommended ceiling 90 s.` | R-009-1, D10 |
| Schema retry exhausted | `The script could not be generated in the required schema after 3 attempts. Failing field: ending. Schema version: script@3. No billable stage ran.` | R-004-2 |
| Reframe check failed | `The reframe check could not complete. Regeneration stays disabled until it can be computed.` | R-006-2, C-07 analogue |
| Source below threshold | `That source scores 1.2, below the 1.5 acceptance threshold.` | QUALIFICATION §3, R-027-2 |
| URL unreachable | `URL unreachable (404) — checked 14:18 UTC. This claim does not count as sourced.` | R-027-2 |
| Approval after acknowledgement | `Approval is allowed. 2 claims are acknowledged as unsourced and are listed in the export source manifest.` | R-027-3/5, OQ-1 default |
| Stale tooltip | `stale: script rev 4, 14:12 UTC` | IP-01 persistence rule |
| Stale accept confirm | `Accept staleness? The narration, timing and render stay as they are and are no longer marked stale. The script has changed since they were produced (rev 4 → rev 5).` | IP-01: clearing is explicit |
| Restart summary | `Worker restarted at 14:02 UTC. 4 videos resumed at their last persisted stage. 0 completed stages re-ran. 0 duplicate attempt rows.` | R-023-1, IP-06 |
| Queue state | `waiting: render slot 1 of 1` | IP-07, R-104 default |
| Leave-page note | `Leaving this page does not stop the job.` | AX-24 |
| Toast (download) | `Package downloaded — 5 files, 41.2 MB` | UC-22; non-state confirmation only |
| Cancel-batch typed confirm | `Type "cancel batch" to confirm. Stops scheduling new stages; in-flight provider calls cannot be aborted and may still bill. Completed assets are kept. Remaining videos become CANCELLED and are excluded from export.` | IP-14, OQ-4 default |
| Cleanup typed confirm | `Type "delete" to confirm. 412 assets, 6.2 GB. 38 assets are protected and will not be deleted. Deleting is permanent.` | IP-13, R-025-3 |

### 9.6 Number formatting (from UX §8.3, implemented)

| Kind | Format | Example |
|---|---|---|
| Counts | plain integer; thousands separator only above 9,999 | `510`, `1,311`, `29` |
| Durations | one decimal with `s`; `mm:ss` with one decimal in the audio transport | `79.1 s`, `05:12.0` |
| Word budget | words and seconds in one line | `216–239 words (71.2–78.7 s)` |
| Bytes | binary units, one decimal | `6.2 GB`, `1.8 GB`, `41.2 MB` |
| Timestamps | ISO-8601 UTC in data contexts; relative in lists with the absolute in the accessible name | `2026-10-20T16:04:00Z`, `2 min ago` |
| Percentages | one decimal, signed where it is a deviation | `+5.5%`, `91%` |
| Pins | `v` + integer, mono, never padded | `v13` |
| Scene ids | `S` + two digits, stable, never renumbered | `S01`…`S17` |

All of the above use `font-variant-numeric: tabular-nums`. A count is never rendered in a proportional font, never abbreviated with `k`, and never rounded.

---

## 10. Handoff notes for the CTO

### 10.1 Component inventory and complexity

Complexity key: **A** = CSS only, **B** = local JS behaviour, **C** = JS + server data/state machine.

| ID | Component | Complexity | Behaviour the implementation must provide | Server data it needs |
|---|---|---|---|---|
| UC-01 | App shell | B | Active route, badge count, service state, skip link | readiness, attention count |
| UC-02 | Breadcrumb + tabs | A/B | Roving tabindex, `aria-current`, sticky | none |
| UC-03 | Stage rail | C | Per-stage state + pin + progress + tooltips + `g`-shortcut jump | stage states, pins, `n of m` progress |
| UC-04 | Video state chip | A | 8 states × 3 sizes | none |
| UC-05 | Stale ribbon | B | Cause/revision tooltip, accept-staleness two-step | stale set + cause + revision |
| UC-06 | Change-impact panel | C | Recompute on every commit; conditional reframe check; gate the regenerate button on a complete preview | impact computation, reframe check, call counts |
| UC-07 | Scene grid | C | Render 17 tiles, selection model, checkpoint banner, keyboard nav | scene list, per-scene state, spans, pins |
| UC-08 | Scene tile | A | Hover/focus/selected/stale/failed variants | image derivative URLs, alt text |
| UC-09 | Compare & replace dialog | C | Attempt history, compare, prompt edit, scoped impact, focus management | attempt rows, provenance, image variants |
| UC-10 | Reorder strip | C | Drag + `Alt+↑/↓`, live consequence, commit without provider calls | scene order, caption remap |
| UC-11 | Batch table | C | Grouped rows, live counters, filters, keyboard row nav, stalled-feed label | batch + per-video states, event feed |
| UC-12 | Batch row | A | 8 row variants | (rendered by UC-11) |
| UC-13 | Retry-scope panel | C | Scope from persisted state, 6 failure variants, focus on Cancel | retry scope computation, attempt rows, error class |
| UC-14 | Claim row | C | 5 states, 3 actions, reachability result | claims, sources, reachability |
| UC-15 | Acknowledge dialog | B | Confirm, record, update counts | acknowledgement write |
| UC-16 | Export integrity panel | C | 5 checks, exclusions, blocked download, posting-order edit | manifest build/validation |
| UC-17 | Data table | A/B | Sticky head, sort where allowed, skeleton/error/empty rows | per-variant datasets |
| UC-18 | Buttons | A | 5 variants × 3 sizes × 6 states | none |
| UC-19 | Form field | B | Validation display, described-by wiring, draft persistence | save endpoints, revision numbers |
| UC-20 | Select + source picker | C | Native select; one custom combobox with reachability | accepted sources, reachability check |
| UC-21 | Dialog | B | Focus trap, Esc, restore focus, typed confirm | none |
| UC-22 | Toast | B | Queue of 1, 8 s, pause on hover | none |
| UC-23 | Status strip, banner, live regions | C | Condition → banner mapping, debounced announcements | readiness, degraded reasons |
| UC-24 | Progress / count / empty primitives | A | Determinate meter, tabular counts | none |

**Distribution:** 5 CSS-only (UC-04, UC-08, UC-12, UC-18, UC-24), 8 local-JS (UC-01, UC-02, UC-05, UC-15, UC-17, UC-19, UC-21, UC-22), 11 server-state (UC-03, UC-06, UC-07, UC-09, UC-10, UC-11, UC-13, UC-14, UC-16, UC-20, UC-23). The three highest-risk are UC-06 (impact preview), UC-13 (retry scope) and UC-11 (live 30-row table); all three are listed by UX §9.4 as CTO decisions, and the UI constrains them only by the questions they must answer.

### 10.2 Technical capabilities this design assumes — please confirm

| # | Assumption | Why the design needs it | If it is not available |
|---|---|---|---|
| 1 | Per-stage state + pin + last-event is queryable per video in one request | UC-03/UC-11 render 11 nodes × 30 rows without N+1 requests | The rail and table would need a coarser summary; the design would degrade to per-stage lazy loading with skeletons |
| 2 | Impact preview can be computed server-side **without** calling a provider | IP-01 requires the consequence before spending (R-006-1) | The panel cannot exist as specified; editing would have to block (C-07 behaviour permanently) |
| 3 | Retry scope is derivable from persisted state (not guessed) | IP-06/AX-25 | Retry would ship without scope, which contradicts the UX guardrail; this is a hard dependency |
| 4 | Reframe check is local and cheap enough to run on a keystroke-commit | The only conditional matrix row | The aspect-ratio row would need a manual "check now" button |
| 5 | A push feed (SSE) or ≤2 s polling for counters | AX-27 (5 s freshness, stalled label) | Polling still satisfies it; the stalled label threshold changes to the poll interval |
| 6 | Image derivatives: a 168×298 thumb, a 360×640 detail, a full 1080×1920 | Tile sharpness vs bandwidth on LAN | Without a thumb variant the grid would load 17 full images (slow on a NAS disk, and 17 × ~1 MB per grid) |
| 7 | Prompt summary is available per scene for `alt` text | AX-15 | `alt` would fall back to `Scene 3 of 17` only, losing the image description |
| 8 | Server-rendered HTML + progressive enhancement is acceptable | The whole design is forms, links and tables; it does not need a client framework | A SPA is possible but must preserve focus (AX-06/07) and native semantics |
| 9 | `font-variant-numeric: tabular-nums` renders in the target browsers | Digit alignment in every table and count | Fall back to the mono stack for all numbers; the design still works, it just looks heavier |
| 10 | CSS custom properties are used as the token layer | Single source for 52 audited pairs; theming later | Hard-coded hex values would break the audit |

### 10.3 Open questions for the CTO (not blockers)

1. **Feed transport.** SSE, WebSocket or polling? The design only requires ≤5 s freshness and a stalled label; anything that meets it is fine.
2. **Image URL contract.** Are derivatives addressed by a query parameter, a path suffix, or a separate table? UC-08/UC-09 need three sizes and stable identifiers.
3. **Mixed-failure announcement summarisation.** When five videos fail within five seconds, what is the single summary string? Proposal: `5 videos failed: 3 at narration, 2 at render. Open Health for detail.` — needs a ruling because AX-10 forbids per-row announcements.
4. **`prefers-reduced-motion` for the render preview.** Is a poster frame always available server-side (so the reduced-motion preview is a still), or must the UI pause a muted video at t=0?
5. **Attempt-row pagination.** IP-08 says "last 50". Is that last 50 per video, per stage, or globally? The UI assumes **per video**, newest first.
6. **Pin summary format for the batch table.** The design proposes `v13 ×5 · v14 ×3` (count per version, newest first). Needs confirmation (see §12 C-3).

### 10.4 What must not happen in implementation

- Do not introduce a light theme, a webfont, an icon package, a chart library or a UI framework that replaces native semantics.
- Do not put the change-impact panel in a modal, drawer or toast (DI-02), and do not let `Enter` on an edit commit a regeneration (AX-04).
- Do not clear a stale badge on navigation, save, restart or a successful unrelated stage.
- Do not add totals, sums, averages, charts or exports over `billed_units`, and do not label any number with a currency (D2, IP-08).
- Do not add publish/schedule/connect/register/reset affordances (D3, D8, D9).
- Do not hide failures behind a generic error component: every failure surface must answer the six questions of AX-25.
- Do not animate an image thumbnail or auto-play audio.

---

## 11. Deliverable report

| Question in the task | Answer |
|---|---|
| **Component count** | **24 components** (UC-01…UC-24), covering all 16 named in the brief plus 8 primitives the screens required (app shell, breadcrumb/tabs, scene grid, reorder strip, batch table, acknowledge dialog, status strip + live regions, progress/count/empty). 5 are CSS-only, 8 need local JS, 11 need server state (§10.1). |
| **Screens mocked** | **11**: W-01…W-10 plus S-01 login, each with exact measurements and a box render. All 21 routed screens are covered by the layout system, the shared workspace shell (W-04) and the component specs; the 11 mockups are the screens the UX spec wireframed plus login. |
| **States designed** | All 8 semantic states (§3), plus per-screen empty / loading / partial / error / blocked / success for all 11 mockups, plus the 6 failure variants of UC-13 and the 8 impact-panel variants of UC-06. |
| **Accessibility requirements not fully satisfiable visually** | Five, listed in §8.6: AX-21 and AX-24 (behavioural guarantees), AX-27 (transport-dependent timing), AX-15 (captions track must be produced by the render pipeline), AX-14 at 200% on the 8-column table (needs the C-1 ruling). All 28 are translated into concrete decisions in §8.1. |
| **Contrast** | 52 token pairs measured with `tools/contrast_audit.py`; **0 failures**; two documented exemptions (disabled text per WCAG 1.4.3, decorative hairlines). |
| **Challenges to UX_SPEC** | **5**, in §12. None changes a flow, a screen or a state; each asks for a ruling on a gap. |
| **Artifacts** | `UI_SPEC.md` (this file), `mockups/ui-mockup.html`, `tools/contrast_audit.py`, `tools/contrast_audit.txt`, `UI_SPEC.sha256`. |

**What the next role should do with this.** Technical design can implement directly from §2 (tokens), §3 (state palette), §5 (components) and §10 (inventory). The developer's browser pass should start from `mockups/ui-mockup.html`, which is the visual reference, and should confirm the 10 assumptions in §10.2 before writing components UC-06, UC-11 and UC-13.

---

## 12. Challenges to UX_SPEC

Five gaps found while designing. None is a redesign: each is a question with a proposed answer, listed here instead of being silently resolved in the visual layer. All are non-blocking for implementation; C-1 should be ruled on before the batch table is built.

### C-1 — IP-05 (30 rows, no pagination, 8 columns) vs AX-14 (200% zoom / 320 px reflow)

**Problem.** IP-05 specifies a 30-row table with no pagination and W-03 gives eight columns. AX-14 requires reflow at 320 px and 200% zoom without loss of function. At 1440 px with 200% zoom the available width is effectively 720 px; eight columns (48+280+96+132+260+120+96+120 = 1,152 px) cannot fit, and the design already answers this by dropping to a card list below 768. The gap is that AX-14 says "without loss of function" while a card list necessarily hides the column-to-column comparison that makes 30 rows scannable.
**Proposed answer.** Treat 200% zoom as the 768–1023 band: keep status, state, attention reason and time in the card; move pins and stage into a second line; keep *Open* and *Retry scope*. Comparison across 30 rows remains possible via the attention filter and group order, but column scanning is lost above 200% zoom. **Ruling needed:** is that an acceptable reading of "without loss of function", or does AX-14 require a horizontally scrollable table instead (which fails 1.4.10 reflow but preserves all columns)?

### C-2 — C-11 says "about 75.1 s", AX-19 bans approximations for computable numbers

**Problem.** AX-19 prohibits "approximately" for anything the system can count, and UX §8.1.1 says "numbers first". C-11 reads `228 words → about 75.1 s`. The value is exact arithmetic (228 ÷ 3.035 = 75.12 s), so "about" undermines the rule the same spec sets.
**Proposed answer.** Use `228 words → 75.1 s at the measured 3.035 words/s` and keep the label `measured` on the pace constant, which is the honest approximation. **Ruling needed:** is dropping "about" from C-11 acceptable, or was the hedge intentional?

### C-3 — W-03 has one `Pins` column per video, but R-002-4 pins are per stage

**Problem.** R-002-4 requires per-stage pin inspection, and F-D/D-6 explicitly expects a mixed set after a mid-batch series edit (`T v13 · … · NA v14 · TC v14 · RE v14`). W-03 shows a single `v13` in the Pins column for each row, which is ambiguous once a video has two versions in play. No summary format is defined anywhere.
**Proposed answer.** Render `v13` when all stages share one pin, and `v13 ×5 · v14 ×3` (count per version, oldest first) when they differ, with the full per-stage set in the video's S-16 provenance panel and in a cell tooltip. **Ruling needed:** confirm the summary format, or specify a different one; the per-stage truth remains in S-16 either way.

### C-4 — 768–1023 offers approvals but no image judging

**Problem.** AX-22 sets a floor ("no gate approval below 768") but does not say what 768–1023 must support. Approving a final render without being able to open the 17-tile grid is a weaker review than R-005-1 intends ("owner can approve … individual visuals"). This spec therefore **narrows** the desktop workflow in that band (replace and reorder disabled with a reason) rather than silently allowing a cramped one.
**Proposed answer.** Keep the narrowing: at 768–1023 the operator can approve script/claims, read QC numbers and approve final after playing the render; image replace and reorder require ≥1024. **Ruling needed:** confirm, or state that per-scene replace must remain available at 768 (in which case the design needs a one-up replace flow with an explicit "judging at reduced size" warning).

### C-5 — IP-02 and IP-05 forbid toasts, but nothing authorises them at all

**Problem.** IP-02 says a version save must not use a toast ("the chip on the page is the record") and IP-05 bans toasts for stage completions. Neither authorises a toast anywhere, yet the component is a normal expectation for download/copy confirmation. The task brief lists toasts as a component to spec, so the visual layer has to decide whether the component exists and, if so, where.
**Proposed answer.** Keep UC-22 restricted to non-state confirmations (`Package downloaded`, `Link copied`, `Copy failed`) and never for progress, gates, saves, or anything needing a decision. **Ruling needed:** confirm the restricted scope, or remove toasts entirely — in which case the download confirmation moves inline next to the download button (the design works either way; one line changes).

---

*End of UI specification. Revision 1. This document changes only through a new revision with a re-recorded hash; `UI_SPEC.sha256` is the record.*
