/**
 * `npm run auth:seed` — the argon2id operator seed one-shot (LEAD_PLAN §4 B-13).
 *
 * Reads OPERATOR_USERNAME / OPERATOR_PASSWORD from the environment, hashes with
 * argon2id, and inserts the single operator row. Idempotent: an existing row is
 * left untouched (there is no reset path, R-015-3). The password and the hash are
 * never printed; the success line names the database and the username only.
 */
import { pathToFileURL } from 'node:url';

import { createPool, describeTarget, poolConfigFromEnv } from '../db/client.js';
import { redactText } from '../security/redact.js';
import { seedOperatorFromEnv } from './operator.js';

export async function seedMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const pool = createPool(env);
  try {
    const target = describeTarget(poolConfigFromEnv(env));
    const seeded = await seedOperatorFromEnv(env, pool);
    console.log(
      `auth:seed: ${target} — operator "${redactText(seeded.username, { env })}" ` +
        `${seeded.created ? 'created (argon2id)' : 'already present (unchanged; no reset path)'}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`auth:seed: failed — ${redactText(message, { env })}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await seedMain();
}
