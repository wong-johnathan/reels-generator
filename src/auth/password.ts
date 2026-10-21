/**
 * argon2id password storage — R-015-1, TECH_DESIGN §10.
 *
 * Parameters are settled by the design (`m=19456, t=2, p=1` — memory-appropriate
 * for the DS923+) and are asserted as a property of the stored PHC string, not
 * as a constant the caller may override. `hash-wasm` is a pure-WASM argon2id
 * implementation: no native build step, so the image and the NAS stay identical
 * and `npm ci` works on every architecture.
 */
import { randomBytes } from 'node:crypto';

import { argon2id, argon2Verify } from 'hash-wasm';

/** TECH_DESIGN §10 verbatim: argon2id m=19456 KiB, t=2, p=1. */
export const ARGON2ID_PARAMS = {
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/** Matches the OPERATOR_PASSWORD policy in src/config/env.ts (≥ 12 characters). */
export const MIN_PASSWORD_LENGTH = 12;
/** A refusal ceiling, not a policy: argon2 cost scales with input length. */
export const MAX_PASSWORD_LENGTH = 1024;

const SALT_BYTES = 16;
const ARGON2ID_HASH = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** A password that violates the operator policy. The message never echoes it. */
export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * The operator password policy (matches OPERATOR_PASSWORD in src/config/env.ts).
 * Exported so the seeder can refuse a bad password *before* touching the
 * database; the message never echoes the value.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `an operator password must be at least ${MIN_PASSWORD_LENGTH} characters (see .env.example)`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `an operator password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

/** True only for a well-formed argon2id PHC string (argon2i/argon2d/bcrypt are not it). */
export function isArgon2idHash(encoded: string): boolean {
  return ARGON2ID_HASH.test(encoded);
}

/**
 * Hash a password with the pinned argon2id parameters.
 *
 * The salt is 16 fresh random bytes per call, so two hashes of the same password
 * differ. Policy violations throw `PasswordPolicyError` — the seed must not
 * create an operator whose password the env validator would have rejected.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);

  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    memorySize: ARGON2ID_PARAMS.memorySize,
    iterations: ARGON2ID_PARAMS.iterations,
    parallelism: ARGON2ID_PARAMS.parallelism,
    hashLength: ARGON2ID_PARAMS.hashLength,
    outputType: 'encoded',
  });
}

/**
 * Verify a password against a stored PHC string.
 *
 * A malformed, foreign-algorithm or empty hash is a refusal, never an exception:
 * login must answer "invalid credentials" and must not leak which half failed.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!isArgon2idHash(encoded)) return false;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}
