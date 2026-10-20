# config/

Non-secret, versioned configuration mounted read-only into the containers at
`/app/config` (TECH_DESIGN §9.1). Secrets belong in `.env`, never here.

Nothing but this README is required at boot yet; later cards add the versioned
invalidation-matrix seed and similar data files.
