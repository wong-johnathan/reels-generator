/**
 * M-006 — series_version immutability, monotonic minting, current pointer
 * (R-002-1, TECH_DESIGN §3.1).
 *
 * M-001 created `series_version` and the `unique(series_id, version)` index but
 * left the §3.1 invariants to the service. B-14 makes them structural, because
 * R-002-1 is a provenance promise (an old version must still say what the
 * profile looked like) and a service-level convention cannot keep it:
 *
 *   1. `version` must be exactly `max(version) + 1` for its series — no gaps,
 *      no reuse, no rewinding (strictly increasing per R-002-1).
 *   2. rows are immutable: UPDATE and DELETE raise. TECH_DESIGN §3.1 says
 *      "UPDATE revoked to app role"; a trigger enforces it for every role the
 *      application runs as, including the migration owner.
 *   3. `series.current_version_id` always points at the highest version,
 *      maintained by the trigger rather than remembered by one code path, so
 *      the §3.1 invariant cannot drift (LEAD_PLAN §3 circular-FK note).
 *
 * Additive only (R-017-3): no column or table is dropped or retyped.
 */
export const M006_SERIES_VERSION_GUARDS_SQL = /* sql */ `
-- ── 1. monotonic mint: version = max(version) + 1 (R-002-1) ──────────────────
CREATE FUNCTION series_version_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected int;
BEGIN
  SELECT COALESCE(max(v.version), 0) + 1
    INTO expected
    FROM series_version v
   WHERE v.series_id = NEW.series_id;

  IF NEW.version <> expected THEN
    RAISE EXCEPTION
      'series_version: version % is not the next version for series % (expected %)',
      NEW.version, NEW.series_id, expected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER series_version_monotonic
  BEFORE INSERT ON series_version
  FOR EACH ROW EXECUTE FUNCTION series_version_guard_insert();

-- ── 2. immutability: a minted version is never rewritten (R-002-1) ───────────
CREATE FUNCTION series_version_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'series_version rows are immutable (R-002-1): % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER series_version_immutable
  BEFORE UPDATE OR DELETE ON series_version
  FOR EACH ROW EXECUTE FUNCTION series_version_reject_mutation();

-- ── 3. current_version_id tracks the highest version (TECH_DESIGN §3.1) ──────
CREATE FUNCTION series_version_advance_current() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE series s
     SET current_version_id = NEW.id,
         updated_at = now()
   WHERE s.id = NEW.series_id
     AND (
       s.current_version_id IS NULL
       OR NEW.version > COALESCE(
            (SELECT v.version FROM series_version v WHERE v.id = s.current_version_id),
            0
          )
     );
  RETURN NEW;
END;
$$;

-- AFTER, so the row exists for the sub-select above and the FK is satisfiable.
CREATE TRIGGER series_version_advance
  AFTER INSERT ON series_version
  FOR EACH ROW EXECUTE FUNCTION series_version_advance_current();
`;
