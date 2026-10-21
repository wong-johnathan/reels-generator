#!/usr/bin/env python3
"""D2 — 17-scene character-drift benchmark (Milestone A gate).

Direct Gemini calls, same model + geometry the image adapter uses
(gemini-nano-banana-2.1, 9:16, 1K, inlineData references). Reference-holding is
what this measures; the adapter's own plumbing is covered by its qualification
test, so this script deliberately does not need Postgres.

Chain: scene 1..17 each receive the canonical reference plus the two most recent
scenes, which is how the production storyboard stage is meant to hold identity.
"""
import base64, json, os, sys, time, urllib.error, urllib.request

MODEL = "gemini-nano-banana-2.1"
BASE = "https://generativelanguage.googleapis.com/v1beta"
OUT = "/opt/data/cache/scratch/drift"
REF = "/opt/data/cache/scratch/prd-review-reels/scene01_ref.png"

env = {}
for line in open("/opt/data/reels-keys.env"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k] = v
KEY = env["GEMINI_API_KEY"]

CHARACTER = (
    "The same recurring protagonist as in the reference images: a woman in her late twenties, "
    "dark brown hair in a low bun with loose strands, round thin-rimmed glasses, an olive-green "
    "utility jacket with shoulder epaulets and a high collar, a small pale scar through her right "
    "eyebrow. Keep her face shape, hair, glasses, jacket and scar identical in every image."
)
STYLE = (
    "Comic-book illustration, flat cel colours, confident ink outlines, limited palette, "
    "vertical 9:16 composition. No text, no lettering, no captions, no logos."
)

SHOTS = [
    "Wide establishing shot: she walks alone into a floodlit underground subway station, seen small in the frame.",
    "Tight close-up lit only by her phone screen at night, her glasses catching the glow.",
    "Over-the-shoulder shot as she studies a wall-mounted control panel.",
    "She crouches in heavy rain under a blue streetlamp, jacket collar up.",
    "She runs up a concrete stairwell, slight motion blur, urgency.",
    "Side profile in a crowded train carriage, other passengers out of focus behind her.",
    "Close-up of her hands holding a paper ticket, her jacket cuff in frame.",
    "Back view: she walks away down a long tiled corridor, one hand on the strap of her bag.",
    "She sits by a cafe window in afternoon light, cup on the table, looking out.",
    "Her face lit from below by a handheld torch in a dark service tunnel.",
    "She leans against a tiled wall with arms crossed, waiting, three-quarter view.",
    "Medium shot mid-sentence, one hand gesturing, eyebrows raised.",
    "Low angle looking up at her from ground level as she looks down at the camera.",
    "She stands silhouetted against a sunset skyline on a rooftop.",
    "Extreme close-up of her eyes and glasses, reflections of fluorescent lights.",
    "She stands still in a moving crowd, everyone else blurred, only her in focus.",
    "Final wide shot: she steps out through a station exit into bright daylight.",
]

def b64(path):
    return base64.b64encode(open(path, "rb").read()).decode()

def call(prompt, ref_paths, out_path):
    parts = []
    for p in ref_paths:
        parts.append({"inlineData": {"mimeType": "image/png", "data": b64(p)}})
    parts.append({"text": prompt})
    body = json.dumps({
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "9:16", "imageSize": "1K"},
        },
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/models/{MODEL}:generateContent?key={KEY}",
        data=body, headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read()[:240].decode(errors='replace')}", time.time() - t0
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}", time.time() - t0
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                open(out_path, "wb").write(base64.b64decode(inline["data"]))
                return True, inline.get("mimeType", "?"), time.time() - t0
    return None, f"no image in response: {json.dumps(data)[:240]}", time.time() - t0

os.makedirs(OUT, exist_ok=True)
records = []
generated = []
t_start = time.time()

for i, shot in enumerate(SHOTS, start=1):
    prompt = f"{CHARACTER}\n\nScene {i} of 17. {shot}\n\n{STYLE}"
    refs = [REF] + generated[-2:]
    out = f"{OUT}/scene-{i:02d}.png"
    ok, info, dt = call(prompt, refs, out)
    rec = {"scene": i, "shot": shot, "refs": len(refs), "ok": bool(ok),
           "detail": info, "seconds": round(dt, 1), "path": out if ok else None}
    if ok:
        generated.append(out)
    records.append(rec)
    print(f"[{i:02d}/17] {'OK' if ok else 'FAIL'} {dt:5.1f}s refs={len(refs)} {'' if ok else info}", flush=True)
    time.sleep(6.5)  # stay under the adapter's 10 req/min ceiling

manifest = {"model": MODEL, "aspect": "9:16", "size": "1K", "reference": REF,
            "scenes": records, "ok_count": sum(1 for r in records if r["ok"]),
            "total_seconds": round(time.time() - t_start, 1)}
json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=2)
print(f"done: {manifest['ok_count']}/17 in {manifest['total_seconds']}s", flush=True)
