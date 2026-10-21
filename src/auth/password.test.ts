import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PARAMS,
  hashPassword,
  isArgon2idHash,
  PasswordPolicyError,
  verifyPassword,
} from './password.js';

const PASSWORD = 'correct horse battery staple';

/**
 * B-13 / R-015-1: the password is stored as an argon2id hash with the exact
 * parameters TECH_DESIGN §10 settles (m=19456, t=2, p=1) — memory-appropriate
 * for the DS923+. These are properties of the stored artefact, not of the
 * adapter's intentions, so they are read back out of the PHC string.
 */
describe('argon2id password storage (R-015-1)', () => {
  it('stores an argon2id PHC string with m=19456, t=2, p=1', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toContain('m=19456,t=2,p=1$');
    expect(isArgon2idHash(hash)).toBe(true);
    expect(ARGON2ID_PARAMS).toEqual({
      memorySize: 19456,
      iterations: 2,
      parallelism: 1,
      hashLength: 32,
    });
  });

  it('salts every hash, so two hashes of one password differ and both verify', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });

  it('verifies the wrong password as false', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(`${PASSWORD}!`, hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('never throws on malformed or foreign hashes — it refuses them', async () => {
    const foreign = [
      '',
      'not-a-hash',
      '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g',
      '$argon2d$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g',
      '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7Z0h1rHtbRvX0YOKCz1eWQ6rXGvVtGe',
    ];
    for (const hash of foreign) {
      await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(false);
      expect(isArgon2idHash(hash)).toBe(false);
    }
  });

  it('refuses to hash a password below the operator policy (12 characters)', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordPolicyError);
  });
});
