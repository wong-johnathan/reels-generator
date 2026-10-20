/**
 * Migration one-shot — B-01 scaffold.
 *
 * B-02 owns the numbered, forward-only migration set (M-001…M-005, 22 tables)
 * and this runner's real implementation. Until it lands, the one-shot starts,
 * prints what it targeted and exits 0, so `deploy/up.sh` can run migrate before
 * `up` on a fresh box without bricking the stack (the R-017-2 ordering is in
 * place; the DDL is not yet).
 */
const target = process.env.POSTGRES_DB ?? 'reels';
const host = process.env.POSTGRES_HOST ?? 'postgres';

console.log(
  `migrate: target ${host}/${target} — no migrations bundled in this build ` +
    '(the M-001…M-005 set and the runner land with B-02). Exiting 0.',
);
process.exit(0);
