/** Explicit opt-in only; malformed configuration must never enable approval. */
export function automaticApprovalActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.AUTO_APPROVE_ALL?.trim() === 'true';
}
