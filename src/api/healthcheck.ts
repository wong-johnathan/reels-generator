/**
 * Container healthcheck — used by compose for `web` and both workers.
 *
 * Kept as a script (not `wget`/`curl`) because the runtime image has neither:
 * node is already there, and the probe answers the same question the NAS cares
 * about — is this container ready to take work (R-018-1/2)?
 */
const url =
  process.env.HEALTHCHECK_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? '8080'}/readyz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    console.error(`healthcheck: ${url} returned ${response.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`healthcheck: ${url} failed: ${(error as Error).message}`);
  process.exit(1);
}
