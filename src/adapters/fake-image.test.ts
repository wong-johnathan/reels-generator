import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { readImageDimensions, readPngText } from './image-bytes.js';
import { FakeImageAdapter } from './fake-image.js';
import {
  ImageRequestValidationError,
  MAX_REFERENCE_IMAGES,
  referenceSetDigest,
  type ImageCallContext,
  type ImageGenerateRequest,
  type InlineImageData,
} from './image.js';

function promptDigest(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function context(prompt: string): ImageCallContext {
  const digest = promptDigest(prompt);
  return { id: `run-${digest.slice(0, 16)}`, stage: 'IM', promptHash: digest };
}

function reference(id: number): InlineImageData {
  return { mime_type: 'image/png', data: Buffer.from(`ref-${id}`).toString('base64') };
}

function request(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'scene one: crouched under a blue streetlamp in the rain',
    reference_images: [reference(1), reference(2)],
    ...overrides,
  };
}

describe('FakeImageAdapter determinism (B-06 Signal)', () => {
  it('is byte-for-byte deterministic for the same request across instances', async () => {
    const first = await new FakeImageAdapter().generate(request(), context(request().prompt));
    const second = await new FakeImageAdapter().generate(request(), context(request().prompt));

    expect(Buffer.from(first.image_bytes).equals(Buffer.from(second.image_bytes))).toBe(true);
    expect(first.provider_request_id).toBe(second.provider_request_id);
    expect(first.seed).toBe(second.seed);
    expect(first.run_id).toBe(context(request().prompt).id);
    expect(first.idempotency_protected).toBe(false);
  });

  it('produces a real 768x1376 PNG for the 1K default', async () => {
    const result = await new FakeImageAdapter().generate(request(), context('geometry'));
    expect(result.mime_type).toBe('image/png');
    expect(readImageDimensions(result.image_bytes)).toEqual({
      format: 'png',
      width: 768,
      height: 1376,
    });
    expect(result.width).toBe(768);
    expect(result.height).toBe(1376);
    expect(result.model).toBe('fake-nano-banana');
  });

  it('honours the 2K size', async () => {
    const result = await new FakeImageAdapter({ imageSize: '2K' }).generate(
      request({ image_size: '2K' }),
      context('2k'),
    );
    expect(readImageDimensions(result.image_bytes)).toEqual({
      format: 'png',
      width: 1536,
      height: 2752,
    });
  });

  it('changes the image when the prompt changes but keeps the same reference marker', async () => {
    const adapter = new FakeImageAdapter();
    const one = await adapter.generate(request({ prompt: 'scene one' }), context('scene one'));
    const two = await adapter.generate(request({ prompt: 'scene two' }), context('scene two'));

    expect(Buffer.from(one.image_bytes).equals(Buffer.from(two.image_bytes))).toBe(false);
    expect(readPngText(one.image_bytes, 'reels_refs')).toBe(
      readPngText(two.image_bytes, 'reels_refs'),
    );
    expect(readPngText(one.image_bytes, 'reels_prompt')).not.toBe(
      readPngText(two.image_bytes, 'reels_prompt'),
    );
  });

  it('changes the reference marker when the reference set changes', async () => {
    const adapter = new FakeImageAdapter();
    const one = await adapter.generate(
      request({ reference_images: [reference(1)] }),
      context('ref one'),
    );
    const two = await adapter.generate(
      request({ reference_images: [reference(2)] }),
      context('ref two'),
    );

    expect(readPngText(one.image_bytes, 'reels_refs')).not.toBe(
      readPngText(two.image_bytes, 'reels_refs'),
    );
  });

  it('stamps the canonical reference-set digest the qualifier verifies', async () => {
    const adapter = new FakeImageAdapter();
    const req = request();
    const result = await adapter.generate(req, context('digest'));

    expect(readPngText(result.image_bytes, 'reels_refs')).toBe(
      referenceSetDigest(req.reference_images),
    );
    const check = adapter.qualificationCheck.check({
      sceneIndex: 0,
      request: req,
      result,
      referenceSha256: referenceSetDigest(req.reference_images),
    });
    expect(check.preserved).toBe(true);
  });

  it('reports drift when simulateReferenceDrift is on (so the qualifier can fail)', async () => {
    const adapter = new FakeImageAdapter({ simulateReferenceDrift: true });
    const req = request();
    const digest = referenceSetDigest(req.reference_images);

    const first = await adapter.generate(req, context('drift one'));
    const second = await adapter.generate(req, context('drift two'));
    const firstCheck = adapter.qualificationCheck.check({
      sceneIndex: 0,
      request: req,
      result: first,
      referenceSha256: digest,
    });
    const secondCheck = adapter.qualificationCheck.check({
      sceneIndex: 1,
      request: req,
      result: second,
      referenceSha256: digest,
    });

    expect(firstCheck.preserved).toBe(true);
    expect(secondCheck.preserved).toBe(false);
    expect(secondCheck.detail).toContain('drifted');
  });

  it('never touches the network', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const result = await new FakeImageAdapter().generate(request(), context('offline'));
    expect(globalFetch).not.toHaveBeenCalled();
    expect(result.image_bytes.length).toBeGreaterThan(0);
  });

  it('enforces the same request rules as the paid adapter', async () => {
    const adapter = new FakeImageAdapter();
    const tooMany = Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, index) =>
      reference(index),
    );

    await expect(
      adapter.generate(request({ reference_images: tooMany }), context('too many')),
    ).rejects.toBeInstanceOf(ImageRequestValidationError);
    await expect(
      adapter.generate(request({ prompt: '' }), context('empty')),
    ).rejects.toBeInstanceOf(ImageRequestValidationError);
  });

  it('records each call in memory for assertions and debugging', async () => {
    const adapter = new FakeImageAdapter();
    await adapter.generate(request({ prompt: 'first call' }), context('first call'));
    await adapter.generate(request({ prompt: 'second call' }), context('second call'));

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls.map((call) => call.prompt)).toEqual(['first call', 'second call']);
  });
});
