/**
 * `npm run qualify:image` — open the image qualification gate (R-008-3).
 *
 * The worker refuses to render images until `provider_qualification` holds a
 * passing row for the (provider, adapter) pair. The fixture adapter is qualified
 * by construction; a real vendor is not, and the Gemini adapter has no automatic
 * reference-preservation verifier — so a human has to look at the output before
 * the gate opens. That is the gate doing its job, not a bug to route around.
 *
 * Two phases, because a computer cannot judge whether three frames look like the
 * same film:
 *
 *   npm run qualify:image                 # generate the fixture scenes to ./qualification/
 *   npm run qualify:image -- --verdict pass --reviewer johnathan
 *
 * Phase two regenerates the same scenes (three cheap calls) and records the
 * verdict, so the row's image hashes match what the reviewer saw only if the
 * model is stable — which is itself the property being tested. The images from
 * phase one are kept so the two runs can be compared.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPool } from '../db/client.js';
import {
  IMAGE_QUALIFICATION_FIXTURE,
  PgImageQualificationStore,
  runImageQualification,
} from '../adapters/image-qualification.js';
import { sha256Hex } from '../storage/object-store.js';
import { IMAGE_ASPECT_RATIO } from '../adapters/image.js';
import { isFakeProviderMode, selectImageAdapter } from '../worker/providers.js';

interface Args {
  readonly verdict?: 'pass' | 'fail';
  readonly reviewer?: string;
  readonly notes?: string;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  };

  const rawVerdict = flag('verdict');
  if (rawVerdict !== undefined && rawVerdict !== 'pass' && rawVerdict !== 'fail') {
    throw new Error(`--verdict must be pass or fail, got "${rawVerdict}"`);
  }

  return {
    ...(rawVerdict === undefined ? {} : { verdict: rawVerdict }),
    ...(flag('reviewer') === undefined ? {} : { reviewer: flag('reviewer')! }),
    ...(flag('notes') === undefined ? {} : { notes: flag('notes')! }),
    outDir: flag('out') ?? 'qualification',
  };
}

export async function qualifyImageMain(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`qualify:image: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (isFakeProviderMode(env)) {
    console.error(
      'qualify:image: PROVIDERS=fake — the fixture adapter is qualified by construction, ' +
        'so there is nothing to measure. Set the real provider keys to qualify Gemini.',
    );
    return 1;
  }

  if (args.verdict !== undefined && (args.reviewer ?? '').trim() === '') {
    console.error(
      'qualify:image: --verdict requires --reviewer "<name>" — the row records who judged.',
    );
    return 1;
  }

  let pool: ReturnType<typeof createPool> | undefined;
  try {
    // Selection throws ProviderConfigError when a key is missing or blank; it
    // belongs inside the try so the operator gets the named-key message rather
    // than an uncaught stack from a one-shot.
    const adapter = selectImageAdapter(env);
    pool = createPool(env);
    const store = new PgImageQualificationStore(pool);
    if (args.verdict === undefined) {
      // Phase one: generate so a human can look. Nothing is recorded; the gate
      // stays closed until phase two.
      await mkdir(args.outDir, { recursive: true });
      console.log(
        `qualify:image: generating ${IMAGE_QUALIFICATION_FIXTURE.scenes.length} fixture scenes with ` +
          `${adapter.provider}/${adapter.adapterName} (gate stays CLOSED until a verdict is recorded)`,
      );

      for (const [index, scene] of IMAGE_QUALIFICATION_FIXTURE.scenes.entries()) {
        const result = await adapter.generate(
          {
            prompt: scene.prompt,
            reference_images: [IMAGE_QUALIFICATION_FIXTURE.reference],
            image_size: adapter.imageSize,
            aspect_ratio: IMAGE_ASPECT_RATIO,
          },
          {
            id: `qualification:${adapter.provider}:${index}`,
            stage: 'IM',
            promptHash: sha256Hex(new TextEncoder().encode(scene.prompt)),
          },
        );
        const file = join(args.outDir, `${String(index + 1).padStart(2, '0')}-${scene.name}.png`);
        await writeFile(file, result.image_bytes);
        console.log(
          `  ${file}  ${result.width}x${result.height} ${result.mime_type} ` +
            `sha256:${sha256Hex(result.image_bytes).slice(0, 12)}`,
        );
      }

      console.log(
        '\nLook at those images: same protagonist, same lens, same palette across all three?\n' +
          'Then record the verdict:\n\n' +
          '  npm run qualify:image -- --verdict pass --reviewer "<your name>"\n' +
          '  npm run qualify:image -- --verdict fail --reviewer "<your name>" --notes "why"\n',
      );
      return 0;
    }

    const outcome = await runImageQualification({
      adapter,
      store,
      verdict: {
        passed: args.verdict === 'pass',
        reviewer: args.reviewer!,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      },
    });

    console.log(
      `qualify:image: recorded ${outcome.passed ? 'PASS' : 'FAIL'} for ` +
        `${adapter.provider}/${adapter.adapterName} (reviewer: ${args.reviewer}).`,
    );
    if (!outcome.passed) {
      console.error(
        'qualify:image: the gate stays closed — the image stage will refuse to render.',
      );
      return 1;
    }
    console.log('qualify:image: the gate is open. The image stage can now render.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`qualify:image: failed — ${message}`);
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await qualifyImageMain();
}
