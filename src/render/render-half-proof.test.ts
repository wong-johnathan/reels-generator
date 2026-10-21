/**
 * Render-half proof against the fake providers and real FFmpeg (no database).
 *
 * This is the local, no-Docker, no-Postgres acceptance test: the fake image
 * adapter produces real PNG scenes, the fake TTS adapter produces a real WAV
 * narration + alignment, and `renderVideo` turns them into a real MP4. The file
 * is then probed with ffprobe to assert the exact acceptance geometry, frame
 * rate and codecs — nothing is stubbed at the media layer.
 *
 * Skipped loudly when FFmpeg is not on PATH (the worker image always has it).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { FakeImageAdapter } from '../adapters/fake-image.js';
import type { ImageGenerateRequest } from '../adapters/image.js';
import { FakeTtsAdapter } from '../adapters/tts.js';
import { buildCaptionDocuments } from './captions.js';
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from './constants.js';
import { ProcessFfmpegRunner } from './ffmpeg.js';
import { buildRenderPlan, type RenderSceneSource } from './plan.js';
import { renderVideo } from './render.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

const workDir = mkdtempSync(join(tmpdir(), 'reels-fake-proof-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg || !hasFfprobe)('fake-provider render half-proof', () => {
  it('renders fake image + fake narration to a real 1080x1920 30fps H.264/AAC MP4', async () => {
    const image = new FakeImageAdapter();
    const tts = new FakeTtsAdapter();

    // Two scenes from the fake image adapter — real PNGs at the documented 1K
    // geometry, produced with zero network and zero credentials.
    const sceneNos = ['S01', 'S02'];
    const scenes: RenderSceneSource[] = [];
    for (let index = 0; index < sceneNos.length; index += 1) {
      const sceneNo = sceneNos[index]!;
      const request: ImageGenerateRequest = {
        prompt: `scene ${sceneNo} of the fake proof`,
        image_size: '1K',
        aspect_ratio: '9:16',
        reference_images: [],
      };
      const generated = await image.generate(request, {
        stage: 'IM',
        id: `fake-proof-image-${index}`,
        promptHash: `fake-proof-image-${index}`,
      });
      const fileName = `img-${sceneNo}.png`;
      writeFileSync(join(workDir, fileName), generated.image_bytes);
      scenes.push({
        sceneNo,
        position: index + 1,
        cameraMove: 'static',
        imageFileName: fileName,
        narrationStartMs: index * 500,
        narrationEndMs: (index + 1) * 500,
      });
    }

    // Narration from the fake TTS adapter — a real WAV plus a character
    // alignment, byte-identical across runs.
    const spoken = 'Every founder has heard the same advice. Move faster.';
    const converted = await tts.convert(
      { text: spoken, voice_id: 'fake-voice', model_id: 'fake-tts-model' },
      {
        stage: 'NA',
        id: 'fake-proof-narration',
        projectId: 'fake-proof',
        promptHash: 'fake-proof-narration',
      },
    );
    expect(converted.audio.byteLength).toBeGreaterThan(44);
    writeFileSync(join(workDir, 'narration.wav'), converted.audio);

    const plan = buildRenderPlan({ scenes, leadS: 0.5, trailS: 0.5 });
    const { cues, documents } = buildCaptionDocuments({
      words: [
        { word: 'every', start_ms: 0, end_ms: 120 },
        { word: 'founder', start_ms: 120, end_ms: 260 },
        { word: 'has', start_ms: 260, end_ms: 340 },
        { word: 'heard', start_ms: 340, end_ms: 480 },
        { word: 'the', start_ms: 480, end_ms: 560 },
        { word: 'same', start_ms: 560, end_ms: 700 },
      ],
      leadS: 0.5,
    });

    const runner = new ProcessFfmpegRunner();
    const rendered = await renderVideo({
      plan,
      workDir,
      narrationFileName: 'narration.wav',
      captions: documents,
      captionCueCount: cues.length,
      runner,
    });

    const probe = await runner.probe(rendered.videoPath);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toBeDefined();
    expect(video!.width).toBe(OUTPUT_WIDTH);
    expect(video!.height).toBe(OUTPUT_HEIGHT);
    expect(video!.codec_name).toBe('h264');
    expect(video!.r_frame_rate).toBe(`${OUTPUT_FPS}/1`);

    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    expect(audio).toBeDefined();
    expect(audio!.codec_name).toBe('aac');

    const durationS = Number(probe.format.duration);
    expect(Number.isFinite(durationS)).toBe(true);
    expect(durationS).toBeGreaterThan(0);
    // lead + trail + two 0.5 s scenes = 2.0 s of frames.
    expect(durationS).toBeCloseTo(plan.totalFrames / OUTPUT_FPS, 0);
  }, 180_000);
});
