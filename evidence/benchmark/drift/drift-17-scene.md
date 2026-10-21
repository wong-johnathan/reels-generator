# Benchmark 2 — 17-scene character drift (Milestone A gate)

**Status:** measured 2026-10-21. Recorded by the coordinator. **Operator confirmation pending** — the AC requires the owner's eyes; this file records the run and a first-pass inspection, not the owner's verdict.

## Setup

- Model: `gemini-nano-banana-2.1`, `9:16`, `imageSize: 1K` — the same model id, geometry and `inlineData` reference mechanism the production image adapter uses (`src/adapters/image.ts`, `DEFAULT_MODEL`, `IMAGE_ASPECT_RATIO`, `DOCUMENTED_1K_GEOMETRY`).
- Canonical reference: `scene01_ref.png` (the character qualified in `QUALIFICATION_RESULTS.md` §1) — woman, late twenties, dark brown hair in a low bun, round thin glasses, olive utility jacket with epaulets, pale scar through the right eyebrow.
- Chaining strategy, as the storyboard stage is meant to hold identity: **scene 1…17 each receive the canonical reference plus the two most recent scenes**. Max 3 references per call, well under the documented ceiling of 14.
- 17 distinct shots chosen to stress identity rather than flatter it: wide establishing, phone-lit close-up, over-the-shoulder, crouched in rain, motion-blurred stairs, side profile in a crowd, **hands only**, back view, café interior, torch-lit tunnel bust, arms folded, mid-sentence gesture, low angle, sunset silhouette, **extreme close-up of eye and glasses**, static in a moving crowd, final exit wide.
- Rate limiting: 6.5 s between calls, staying under the adapter's 10 req/min ceiling.

## Result

| Metric                      | Value                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Scenes generated            | **17 / 17**, 0 failures                                                                                    |
| Wall-clock                  | 518.0 s total (30.5 s/scene including the rate-limit sleep)                                                |
| Per-call generation time    | 15.6 s – 35.4 s (median ≈ 25 s)                                                                            |
| Off-model scenes            | **0**                                                                                                      |
| Verifiable on face/design   | 11 of 17 (6 are back views, wide shots or hands-only)                                                      |
| Contradicting the reference | 0 of the 6 partially-verifiable scenes                                                                     |
| Text/lettering leaked       | 1 minor: scene 07 (ticket) has tiny illegible printed marks; scene 03 (control panel) has label-like marks |

**First-pass judgement (vision inspection of `drift-contact-sheet.png`):** the protagonist is recognisably the same character in every frame. Hair (dark brown low bun), round thin glasses, olive utility jacket with epaulets and collar, and dark trousers hold across all 17. The scar is legible in the close and medium front shots and simply not resolvable in wide, back or profile shots.

Variation observed, all attributable to pose/lighting/framing rather than identity: scenes 10 and 11 read slightly broader in the face (torch from below; arms-crossed angle); scene 15 makes the glasses rim appear thicker and larger because of the macro framing.

**Risk retired:** the CTO's top-ranked risk (17-scene character drift, previously measured only across 3 scenes) is **not reproduced at 17**. The `gemini-3-pro-image` escalation path (R-101) does not need to be pulled forward on drift grounds.

## Limitations, stated rather than papered over

1. **The AC's judge is the operator, not the agent.** This is a first pass; the owner's verdict on `drift-contact-sheet.png` is what satisfies the gate.
2. Scripted by direct provider calls, not by driving the production orchestration. The adapter's reference/output plumbing is covered by its own qualification test; what this measures is model behaviour under the chaining strategy, which is identical either way.
3. Six scenes cannot confirm a face and are recorded as consistent-by-absence-of-contradiction, not as confirmations.
4. The "no text" style rule leaks into incidental surfaces (a ticket, a control panel) at 1K. Captions are burned in downstream, so this is cosmetic — but a storyboard prompt that names the surfaces to avoid would suppress it.

## Artifacts

- `drift-contact-sheet.png` — reference + all 17, labelled.
- `scene-01.png … scene-17.png` — full-resolution 768×1376 outputs.
- `manifest.json` — per-scene shot text, reference count, duration, outcome.

Cost: 18 images ≈ **$0.60** at the documented $0.0336/image.
