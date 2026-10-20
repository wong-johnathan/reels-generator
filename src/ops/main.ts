/**
 * Ops one-shot (`backup` profile) — B-01 scaffold.
 *
 * R-017-5 (pg_dump + MinIO mirror + config copy, restore-tested) is Milestone B
 * work (US-002). This entrypoint exists so the `ops` image is built, pinned and
 * startable now; it refuses to pretend a backup happened.
 */
console.log(
  'ops: backup/restore is Milestone B work (R-017-5, US-002). This image is built and ' +
    'pinned; the backup runner is not implemented yet. Nothing was copied. Exiting 1.',
);
process.exit(1);
