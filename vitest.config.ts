import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'contract/**/*.test.ts', 'tests/**/*.test.ts'],
    restoreMocks: true,
    reporters: ['default'],
    // The schema/auth tests provision a throwaway database and apply M-001…M-005
    // (each migration is one committing transaction). That is tens of seconds of
    // real PostgreSQL DDL, not a hang — B-02 recorded ~67 s for the DB suite.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
