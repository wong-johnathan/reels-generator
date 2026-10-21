# F-01 — UI foundation + shell (acceptance evidence)

|                                         |                                                                    |
| --------------------------------------- | ------------------------------------------------------------------ |
| Task                                    | `t_cc4bea65` (F-01 in `LEAD_PLAN.md` §5)                           |
| Branch                                  | `feat/t_cc4bea65`                                                  |
| Base                                    | `3f70438` (B-01 foundation)                                        |
| Implementation commit                   | `0f9b17d92d5caddd03e319b89bf2659198b082f0`                         |
| Isolated worktree used for verification | `/opt/data/engineering-team/worktrees/t_cc4bea65`                  |
| Authoritative specs                     | `UI_SPEC.md` §2/§4/§7/§8, `UX_SPEC.md` §7, `LEAD_PLAN.md` §1/§5/§6 |

**Signal line (verbatim).** "tokens + shell render against mock data."

**Result: PASS.** The committed branch serves the token stylesheet, the app shell (status strip, left rail, breadcrumb, mobile bar, degraded banner, aside/footer slots, both live regions) rendered from `contract/mock/fixtures.ts` through the frozen `contract/api.ts` schemas, at every responsive band, with zero network/provider calls.

---

## 1. How to reproduce

```bash
git checkout feat/t_cc4bea65
npm ci
npm run verify          # lint + typecheck + test + build
npm run format:check
PREVIEW_PORT=4024 npx tsx src/web/preview.ts   # http://127.0.0.1:4024/
```

Preview routes: `/` (overview shell), `/workspace` (workspace shell with aside + footer), `/assets/app.css`, `/assets/client/shell.js`, `/assets/client/behaviours.js`.

## 2. Real command output

| Command                                                                          | Result                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run verify`                                                                 | **PASS** — lint clean, `tsc -p tsconfig.json` clean, **15 files / 241 tests passed**, `tsc -p tsconfig.build.json` clean |
| `npm run format:check`                                                           | **PASS** — "All matched files use Prettier code style!"                                                                  |
| `npm test -- tests/web`                                                          | **PASS** — 7 files / **180 tests**                                                                                       |
| `git log --all -- .env`                                                          | empty (0 lines) — no credential has ever been committed                                                                  |
| preview `GET /` `/workspace` `/assets/app.css` `/assets/client/shell.js` `/nope` | 200 / 200 / 200 / 200 / 404                                                                                              |

Web test files (all passing):

```
tests/web/tokens.test.ts       (85 tests)
tests/web/shell.test.ts        (36 tests)
tests/web/client.test.ts       (23 tests)
tests/web/styles.test.ts       (16 tests)
tests/web/preview.test.ts       (9 tests)
tests/web/shell-client.test.ts  (6 tests)
tests/web/embedded.test.ts      (5 tests)
```

## 3. Acceptance mapping — UI_SPEC §2 / §4 / §7 / §8

| Spec item                                                                                       | Implementation                                             | Test evidence                                                                                                                                                                                                                                                                                                                                                                                  | Result                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| §2.1 colour tokens (7 surfaces, 4 tints, 6 text, 7 state, 3 borders, 5 fills)                   | `src/web/styles/tokens.css`                                | `tokens.test.ts :: declares --<token> as <hex>` (it.each over the full ledger) + `declares exactly the surfaces, tints, text, state and border tokens — no extra colour`                                                                                                                                                                                                                       | PASS                                                              |
| §2.1/§8.2 measured contrast (AX-12)                                                             | same file                                                  | `tokens.test.ts :: <fg> on <bg>` — 24 pairs recomputed with an independent WCAG 2.2 implementation and compared with the spec's measured ratio (±0.1); `#FFFFFF on both filled button backgrounds`                                                                                                                                                                                             | PASS — 0 failures                                                 |
| §2.2 elevation + §4.1 z-index scale                                                             | tokens                                                     | `declares the radii, elevation and z-index scales`                                                                                                                                                                                                                                                                                                                                             | PASS                                                              |
| §2.3 type scale, three weights, tabular numbers, no webfont                                     | tokens + `base.css`                                        | `declares --t-*/--lh-*`, `declares only the three permitted weights`, `keeps tabular figures… and a mono face`, `ships no webfont and no external asset reference`                                                                                                                                                                                                                             | PASS                                                              |
| §2.4 spacing scale (4 px base, no arbitrary step)                                               | tokens                                                     | `declares the 4 px spacing scale with no arbitrary steps`                                                                                                                                                                                                                                                                                                                                      | PASS                                                              |
| §2.5 radii                                                                                      | tokens                                                     | `declares the radii, elevation and z-index scales`                                                                                                                                                                                                                                                                                                                                             | PASS                                                              |
| §2.6 iconography (no icon package)                                                              | inline 3-letter rail glyphs, no icon dependency            | `ships no webfont and no external asset reference`; see limitation L2                                                                                                                                                                                                                                                                                                                          | PASS (with deviation L2)                                          |
| §2.7 motion + reduced motion (AX-16)                                                            | tokens + `base.css`                                        | `declares the four durations with their easings`, `collapses every duration to 0.01ms under prefers-reduced-motion: reduce`, `stops animation and collapses transition time under reduced motion`; browser check: `--dur-1/--dur-4/--spin-duration = 0.01ms`, 0 animated elements                                                                                                              | PASS                                                              |
| §2.8 focus ring, target sizes (AX-17, AX-18)                                                    | tokens + `base.css`                                        | `declares the outline-based focus ring tokens`, `paints the focus ring with outline, never box-shadow`, `declares the 24 px minimum and the 44 px review-control targets`, `gives every rail link … at least 24 px`; browser check after one Tab: `2px solid rgb(126,166,248)`, offset `2px`                                                                                                   | PASS                                                              |
| §4.1 shell regions (40 px strip, 216/64 rail, fluid content ≤1600, 360/320 aside, 32 px footer) | `shell.css`, `render/shell.ts`                             | `lays out a sticky status strip, a sticky rail and a fluid main region`, `keeps the workspace footer sticky at 32 px`, `renders the optional aside as a labelled complementary column`, `renders the sticky workspace footer only when a workspace supplies it`; browser check: strip 40 px, rail 216 px, aside 360 px, footer 32 px pinned                                                    | PASS                                                              |
| §4.2 vertical rhythm / §4.4 density                                                             | shell spacing tokens, rail 36 px rows                      | covered by the token + geometry assertions; table/scene density belongs to F-04+                                                                                                                                                                                                                                                                                                               | N/A here                                                          |
| §5 UC-01 app shell                                                                              | `renderStatusStrip`, `renderRail`                          | `is the banner landmark above the rail and main`, `names the service state in words`, `shows the exact in-flight count, the attention count and the operator id`, `is the single Primary navigation landmark with the five destinations and Settings last`, `marks the active destination with aria-current="page" and only that one`, `carries the attention badge on the Overview item only` | PASS                                                              |
| §5 UC-02 breadcrumb                                                                             | `renderBreadcrumb`, `renderMobileBar`                      | `renders an ordered breadcrumb in a labelled nav with the current item unlinked`, `offers a back link and the attention count in the sub-1024 top bar`, `omits the back link at the root`                                                                                                                                                                                                      | PASS                                                              |
| §5 UC-23 status strip, degraded banner, live regions                                            | `renderStatusStrip`, `renderDegradedBanner`, `renderShell` | `links the degraded cause to Health`, `names the cause, what is blocked, what still works and the next action`, `lists further conditions instead of stacking banners`, `is absent when nothing is degraded`, `ends the body with an empty polite and an empty assertive region`                                                                                                               | PASS                                                              |
| §7.1/§7.2 bands: ≥1440 / 1024–1439 / 768–1023 / ≤767 / ≤480                                     | `shell.css` media queries                                  | `full workbench at >=1440`, `compressed workbench at 1024–1439` (64 px rail + clipped label + 320 aside + 20 px padding), `review-lite below 1024` (rail hidden, 44 px mobile bar, word-only strip), `monitoring below 768` (counts/operator/freshness hidden, footer static), `phone at <=480` (16 px padding, single column)                                                                 | PASS                                                              |
| §7.3.1 no horizontal page scroll (AX-14)                                                        | `base.css` `overflow-x: clip`                              | `never allows horizontal page scroll`; browser checks at 1440/1100/1023/800/390/320: `scrollWidth − clientWidth = 0`                                                                                                                                                                                                                                                                           | PASS                                                              |
| §7.3.2 primary action never hidden                                                              | shell renders no actions; slots are caller-owned           | `declares every band as a working surface, not a hidden one` (no `display:none` on main/content)                                                                                                                                                                                                                                                                                               | PASS (shell scope)                                                |
| §8.1 AX-01…AX-28                                                                                | see §4 below                                               |                                                                                                                                                                                                                                                                                                                                                                                                | PASS for shell-owned items; later-card items listed as follow-ups |
| §8.3 focus ring variants                                                                        | `base.css`                                                 | `paints the focus ring with outline…` (outline, never removed); table-row inset variant belongs to the table component (later card)                                                                                                                                                                                                                                                            | PASS (shell scope)                                                |
| §8.5 announcement strategy                                                                      | `client/behaviours.ts`, `client/shell.ts`                  | `coalesces a burst to at most one announcement per five seconds`, `empties itself after ten seconds`, `announces urgent messages immediately`, `names the video, the gate and the count when a gate opens`, `summarises batch progress as counts only`                                                                                                                                         | PASS                                                              |
| §9.1 copy rules                                                                                 | renderer strings                                           | `uses no banned product strings and no currency`, `uses one wording per state word`, `escapes every interpolated string`                                                                                                                                                                                                                                                                       | PASS                                                              |

## 4. AX-01…AX-28 status at F-01

| ID                                                    | Shell-level evidence                                                                                                                                                                                                            | Result                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| AX-01 keyboard-only loop                              | skip link is the first focusable element and moves focus to `#main` (browser: Tab → `a.skip-link`, Enter → `activeElement = MAIN#main`); every control is a native link/button; no drag-only or hover-only control in the shell | PASS (shell layer)      |
| AX-02 focus order = visual order                      | DOM order: skip link → header → rail → main → live regions; one `h1`; breadcrumb `ol`                                                                                                                                           | PASS                    |
| AX-03 no shortcut conflicts                           | `isTextField` / `shouldAnnounce` gate; `suppresses non-operator announcements while focus is in a text field`                                                                                                                   | PASS                    |
| AX-04 no spend default focus                          | no spend control in F-01; `focus management primitives` provide the trap/restore helpers later gates must use                                                                                                                   | N/A (F-05/F-06)         |
| AX-05 reorder without drag                            | not in F-01                                                                                                                                                                                                                     | N/A (F-06)              |
| AX-06 focus never moves on background update          | enhancement never re-renders or focuses: `initShell` only writes live-region text and the freshness label                                                                                                                       | PASS (shell layer)      |
| AX-07 focus to status on regeneration, back on settle | helper primitives only; caller-owned                                                                                                                                                                                            | N/A (F-05)              |
| AX-08 gate announcement names video/gate/count        | `gateAnnouncement` exact template + singular case                                                                                                                                                                               | PASS                    |
| AX-09 dialogs trap/Esc/return focus                   | `nextFocusIndex` wrap both directions, `FOCUSABLE_SELECTOR` excludes disabled and `tabindex="-1"`, `isFocusable`                                                                                                                | PASS (primitives)       |
| AX-10 debounced progress summary                      | coalescing + clear-after-10 s tests                                                                                                                                                                                             | PASS                    |
| AX-11 disabled control exposes reason                 | shell has no disabled gate; `aria-describedby` wiring belongs to UC-18/UC-19 (later card)                                                                                                                                       | N/A                     |
| AX-12 contrast                                        | token audit, 24 pairs recomputed                                                                                                                                                                                                | PASS                    |
| AX-13 state never colour-only                         | every strip state renders a word (`Service ready` / `DEGRADED` / `Service not ready`); dot is `aria-hidden`; banner states the cause in text                                                                                    | PASS                    |
| AX-14 reflow 320 px / 200 % zoom                      | 320 px: no horizontal scroll; bands at 1023/767/480 are working surfaces                                                                                                                                                        | PASS                    |
| AX-15 image/video names                               | no media in F-01                                                                                                                                                                                                                | N/A                     |
| AX-16 reduced motion                                  | CSS collapse + browser check (0 animated elements)                                                                                                                                                                              | PASS                    |
| AX-17 target sizes                                    | 24 px minimum tokens, rail links 36 px, mobile bar 44 px; measured in the browser                                                                                                                                               | PASS                    |
| AX-18 focus indicator                                 | 2 px outline, 2 px offset, 7.36:1; measured in the browser                                                                                                                                                                      | PASS                    |
| AX-19/20 exact numbers, one wording per state         | `countPair`, `progressAnnouncement`, single state vocabulary; banned-string audit                                                                                                                                               | PASS                    |
| AX-21 unsaved drafts, AX-24 leaving does not cancel   | behavioural guarantees of later edit surfaces; F-01 provides no draft surface                                                                                                                                                   | N/A                     |
| AX-22 phone monitoring-only                           | ≤767 hides counts/operator; ≥768 approval capability is a later-card decision; no gate is rendered by the shell                                                                                                                 | PASS (shell layer)      |
| AX-23 destructive confirms                            | no destructive control in F-01                                                                                                                                                                                                  | N/A                     |
| AX-25 failure surface six questions                   | degraded banner renders cause / blocked / still works / system + next action link                                                                                                                                               | PASS (degraded variant) |
| AX-26 never claim unbilled                            | no billing surface in F-01                                                                                                                                                                                                      | N/A                     |
| AX-27 ≤5 s counters, stalled feed labelled            | client freshness clock: `last update N s ago`, `data-stale="true"` and `progress feed delayed — last update N s ago` past 20 s; browser check after `prefers-reduced-motion` toggle                                             | PASS (label + clock)    |
| AX-28 no blocking spinner                             | per-region slots only; no full-screen loading state                                                                                                                                                                             | PASS                    |

## 5. Browser evidence (Chromium via CDP, preview from `contract/mock/fixtures.ts`)

| Width                            | Measured                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1440×900                         | rail 216 px, aside 360 px, strip 40 px, footer 32 px pinned at y=844, page overflow 0                           |
| 1100×800                         | rail 64 px (glyph `OVW` + badge, no overlap), aside 320 px, padding 20 px, page overflow 0                      |
| 1023×800                         | rail `display:none`, 44 px mobile bar with back link + `Attention (2)`, single column (999 px), strip word only |
| 800×900                          | mobile bar, single column (776 px), aside stacked, footer pinned, page overflow 0                               |
| 390×800                          | strip = dot + `DEGRADED` only, single column 358 px, page overflow 0                                            |
| 320×800                          | page overflow 0 (reading surface reflow, AX-14)                                                                 |
| keyboard                         | 1st Tab → skip link, outline `2px solid rgb(126,166,248)` at offset 2 px; Enter → focus `MAIN#main`             |
| `prefers-reduced-motion: reduce` | `--dur-1/--dur-4/--spin-duration = 0.01ms`, 0 elements with a running animation                                 |

Screenshots (in `evidence/`):

- `t_cc4bea65-1440-workspace.png`
- `t_cc4bea65-1100-compact.png`
- `t_cc4bea65-800-review-lite.png`
- `t_cc4bea65-320-phone.png`
- `t_cc4bea65-focus-skip-link.png`

## 6. Files changed

```
src/web/styles/tokens.css        UI_SPEC §2 token ledger + §4.1 geometry + reduced-motion overrides
src/web/styles/base.css          reset, document type, .sr-only/.skip-link, focus ring, reduced motion
src/web/styles/shell.css         shell grid, strip, rail, breadcrumb, banner, aside/footer, 5 bands
src/web/styles/embed.ts          CSS-bundle generator (image copies only TS output)
src/web/styles/embedded.ts       generated CSS bundle (drift-guarded)
src/web/render/html.ts           escaping
src/web/render/shell.ts          shell view model + server renderer
src/web/format.ts                counts + freshness wording shared by server and client
src/web/client/behaviours.ts     live-region budget, announcement templates, focus primitives
src/web/client/shell.ts          progressive-enhancement wiring (freshness + live regions)
src/web/preview.ts               dev preview server (fixtures only, no network)
tests/web/*.test.ts              180 tests across 7 files
tests/web/helpers/{html,css}.ts  structure reader + CSS reader/contrast maths
evidence/*                       this file + 5 screenshots
```

## 7. Limitations and follow-ups (not in this diff)

- **L1 — asset wiring.** `src/api/server.ts` is devbackend-owned, so F-01 does not mount the CSS bundle or the compiled client modules in the production server. INT-01/F-02 must serve `APP_CSS` at `/assets/app.css` and `dist/src/web/client/*.js` at `/assets/client/*.js`, with the CSP used by the preview. The dev preview does this today by transpiling the client sources.
- **L2 — compact rail glyphs.** UI_SPEC §2.6 fixes 21 product glyphs and contains no navigation icon set, while §7.1 asks for an "icon rail". The compact band therefore uses the 3-letter form (`OVW`, `SER`, `BAT`, `PST`, `HLT`, `SET`) as the visible glyph and keeps the full label as the accessible name and tooltip. Confirm with design whether a nav icon set should be added.
- **L3 — strip attention count (spec conflict).** UI_SPEC §5 UC-01 says the attention count appears "only on Overview"; the §6.5 composition frame shows a `4 need attention` chip on the S-10 Script screen. Resolved in favour of UC-01 (component spec) and raised as a task comment. No behaviour is hidden: the rail badge carries the count on every screen.
- **L4 — rail aria-current on workspace screens.** A video workspace is not one of the five rail destinations, so the shell renders no `aria-current` there rather than claiming a false one. F-04 passes its `nav` key when it wants Overview highlighted.
- **L5 — DOM tests.** jsdom could not be added (package installation is blocked by the environment's policy), so DOM-level behaviour is tested through injected fakes and a strict HTML structure reader; QA should still do the keyboard/screen-reader pass in a real browser.
- **L6 — transport.** SSE/polling freshness (AX-27) is consumed by F-04; F-01 ships the label, the clock and the announcement budget only.
- **L7 — shared tree.** The shared workspace directory was being written concurrently by devbackend (B-02/B-03). All verification above ran in an isolated `git worktree` of this branch; the shared tree's full-tree typecheck failures at the time belonged to their uncommitted files.
- **L8 — preview scope.** `src/web/preview.ts` is a development/demo surface (no auth, no session, no API), not the production entrypoint.

## 8. Secrets

No `.env`, key, token or credential is included in this branch or in this evidence. Provider keys are not read by any F-01 code path; `git log --all -- .env` is empty.
