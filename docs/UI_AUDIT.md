# UI_AUDIT.md — Independent scoped remediation audit

## Identity and interpretation

Audited implementation: `993203809309893b77643b71b42004f043a20841`.
Base: `392e93232c72f9864ac5dd59fbe7a10415ce6736`.
QA task: `t_e2605f0d`; change-request via lead: `t_847ad700`.
Result: FAIL / NOT RELEASE-READY. This document is not release authorization.

Authoritative specifications inspected: UI_SPEC.md §§7.1/7.2/8/9 and UX_SPEC.md
AX-02/14/17/22/25/26. See TEST_REPORT.md for commands, hashes and evidence.

The original repository-root audit was not present/tracked at the integrated SHA.
Its global compliance labels and statement that scene pager/list did not exist were
stale. This replacement is a QA deliverable in an isolated checkout, to be integrated
by the lead as documentation; it does not retroactively change the audited SHA.
PASS below means the named checks and fixtures passed, NOT every state of the product.

## Verification environment

Clean npm ci then npm run verify on Node v20.20.2: PASS, 1743 tests passed,
238 DB tests skipped. Local runtime tarball verified against official SHA256 list.
Chromium 149.0.7827.55; local real SSR + embedded CSS + compiled client modules;
seven widths 1440/1024/768/767/480/390/320, JS enabled and disabled.
288 recorded browser cases; 28 failing timeout-disclosure combinations.
No authenticated production service or provider used. No production media acceptance.

## Requirements-to-surface map

| Surface/state                                                    | Requirement           | Scoped verdict                  | Evidence / remaining gap                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct scene detail: stored image, replace wired/unwired/blocked | D1 / AX-22 / UI §7.2  | PASS                            | Below1024 section display:none; not in tab/AX; exact width note at768, canonical monitoring note at<=767; direct fixture URLs, JS on/off. Authenticated app route not exercised in browser.                                                                                |
| Direct scene detail: no stored image                             | D1                    | PASS (visibility sample)        | Same width-note branch independently rendered at all seven widths; no invented image.                                                                                                                                                                                      |
| Storyboard pending optional approval                             | D2 / AX-22            | PASS                            | Approve hidden and excluded from tab/AX below768; present>=768; visible control >=44px.                                                                                                                                                                                    |
| Storyboard approved and blocked/no-storyboard                    | D2 / AX-02            | PASS (sampled states)           | No active approval exposed at seven widths JS on/off; all scene-link targets measured; last scene link keyboard focus remains within viewport. New developer browser suite only covers pending, so regression coverage remains G.                                          |
| Failed batch retry                                               | D3 / AX-22 / AX-17    | PASS                            | Hidden display:none, absent from AX/tab below768, canonical monitoring line; >=768 retry179.17×44px and8px adjacent paragraph gap.                                                                                                                                         |
| Scene grid desktop geometry                                      | D4 / AX-02 / UI §7.2  | PASS                            | 1024 actual four columns S01→S05→S01;1440 six S01→S07→S01; resize1024→1440→1024 uses live stride. JS-off geometry also measured.                                                                                                                                           |
| Scene tablet pager / phone list                                  | UI §7.2 / AX-02       | PARTIAL                         | Existing transforms present. Independent pager next/previous/arrow focus passes at768; controls44px high/gap8px. Resizing focused pager to desktop returns focus to BODY; logical focus restoration is not verified. Durable new developer pager/resize regression absent. |
| Shell degraded status cause and Sign out                         | D5 / AX-17            | PASS                            | Desktop cause108.73×24px; Sign out64.92×24 at1440,63×36 at1024 in QA fixture. Hidden below1024. Added unit tests are CSS/string checks; real-browser durable regression G.                                                                                                 |
| Scene All scenes and storyboard links                            | D5 / AX-17            | PASS                            | Back69.375×24px; storyboard links24×24 across sampled pending/approved layouts, JS on/off.                                                                                                                                                                                 |
| Batch series link / review / retry                               | D5 / AX-17            | PASS                            | Series147.09×24px; workspace130.05×44px; retry179.17×44px. Not a global all-primary-neighbor gap audit.                                                                                                                                                                    |
| Failed batch failure detail                                      | D6 / AX-25/26         | FAIL                            | Six conceptual AX25 answers have topic/script/scene-record/job sources, but timed_out + unknown_charge with pending/null charge omits unknown charge. Successful image/narration survival not sourced by this view.                                                        |
| Quality awaiting approval monitoring copy                        | D7 / UI §§7.1/9       | PASS                            | Exact canonical1024px note computed visible below768 with JS on/off. Quality approve copy/target and all blocking variants not globally accepted by this audit.                                                                                                            |
| Series table long-name overflow                                  | AX-14                 | PASS (fixture)                  | Labelled focusable region and actual ArrowRight scroll at>=768, seven widths JS on/off; not just html.scrollWidth.                                                                                                                                                         |
| Script/series monitoring state                                   | AX-22 / AX-20         | OPEN separate chain             | Re-ran56 fixture cases incl container scroll/resize. Does not re-test delayed async summary. Existing failed QA t_dad420de and follow-up t_1e078a82→t_2a1bfecf remain authoritative; no duplicate fix.                                                                     |
| Tokens/contrast, all other review/export/health/settings states  | Other AX requirements | NOT TESTED globally in this run | Existing unit regressions passed, not independent all-state browser acceptance. No blanket compliant label.                                                                                                                                                                |

## AX-25 sources and honest limitations

- What failed + which stage: selected failed job.stage and job_attempt.error_message.
- Class: job_attempt.error_class; nullable displays "not recorded", not a fabricated class.
- Attempts used: selected attempt_no, not an aggregate across unrelated jobs.
- What survived: topic row, latest script revision, scene row count. These are retained
  records, not proof of successful/approved image or narration assets. Successful
  image/narration survival counts are not supplied by BatchVideoDetail.
- Retry scope: domain/regenerate.ts requeues failed jobs only and leaves succeeded jobs
  and content intact. Static explanation matches code; live DB retry not exercised.
- Next operator action: regenerate at768px or wider. No claim that retry is free.
- Billing: latest generation_run.charge_status and stored attemptStatus/runStatus are
  surfaced by loader, but renderer only consumes chargeStatus for disclosure. The
  surfaced timeout evidence must not disappear when charge is pending/null (D6-R).
  Do not infer or rewrite the stored billing facts to fix presentation.

## Coverage gaps / release blockers

1. Correct D6 timeout disclosure and tests that currently expect omission; include
   actual timed_out/unknown_charge evidence with pending/null charges.
2. Promote QA state/pager/target probes into developer regressions, including logical
   focus destination after band resize, all primary44px/8px neighbors, and authenticated
   direct route integration where possible.
3. Provide reproducible browser runner: npm verify excludes .browser.mjs, browser
   dependency not pinned here, surface-followup harness needs executable override.
   Coordinate active runner owner t_66164aad rather than duplicate package.json work.
4. DB enabled verification BLOCKED: TEST_DATABASE_URL absent;238 skips, including new
   SQL contract scenarios. Separate native pipeline timeout diagnosis is not cleared.
5. Browser fixture media URLs do not resolve. Screenshots show broken image/alt-text
   placeholders; no image quality, video playback or complete media workflow acceptance.
6. Firefox/WebKit, real assistive-technology session,200% zoom and full production
   gate/session-expiry workflow NOT TESTED. No global AX compliance assertion.

All remaining items routed through lead t_847ad700 and original owner-card comments.
Existing human gate t_de560b30 stays blocked; never completed or unblocked by QA.
