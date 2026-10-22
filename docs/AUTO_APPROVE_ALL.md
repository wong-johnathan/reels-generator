# Automatic approval

`AUTO_APPROVE_ALL` is an optional boolean environment setting. Only `true` and
`false` are valid; absent/blank defaults to `false`. It is part of `env:validate`
and the generated `.env.template`. Set `AUTO_APPROVE_ALL=true` consistently in
web, content-worker and render-worker environments and restart those services.
To disable it, set `false` (or remove it) and restart. This code change does not
modify an operator's live environment or approve existing production work.

When enabled:

- After successful storyboard generation, SB still enters `awaiting_approval`.
  The worker reads its revision and calls the same transactional storyboard
  approval gateway as the operator. That transaction records an `approve` in
  `review_decision`, with `reason=auto_approve_all` and `revision_at_decision`,
  releases SB and queues IM. Duplicate delivery does not duplicate decisions.
- RE schedules the existing QC runner rather than marking the project complete
  at RE. Only a real QC pass opens FA. The QC runner reads the render revision
  and calls the normal FA approval gateway. Its transaction records the same
  approval marker, releases FA and queues the existing EX runner. EX retains its
  own QC, approval and asset/blob checks. No automatic flag is consulted to
  weaken these checks.
- Every authenticated shell page displays “Automatic approval active”. The UI
  reflects the web process's configuration, so all processes must use the same
  setting.

When disabled, SB and FA require manual approval, and the legacy production RE
end-of-rail behavior is unchanged. Already queued QC/EX work remains executable;
disabling the flag does not undo decisions or cancel jobs already authorized.
There is no background sweep to approve old parked projects on a flag change.

Automatic confirmation does not override stale revisions/stages, failed or
unfinished QC, missing scenes/deliverables, provider qualification, content
validation, or export checks. Refusals propagate rather than silently retrying
with a changed revision. Approvals use the normal project/stage locks and commit
the decision and downstream job together. Automated decisions have no human
`decided_by` identity; the reason marker identifies the automatic actor.

Verification: `npm run verify`. Postgres-backed approval/ledger tests also need
`TEST_DATABASE_URL` pointing at an isolated test cluster with pgvector/pgcrypto
and CREATEDB privileges (see `tests/helpers/pg.ts`); otherwise they explicitly
skip. Unit tests exercise normal gateway validation and SQL ledger writes without
a database, but do not substitute for the Postgres transaction/concurrency tests.
