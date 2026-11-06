/** Ready marker consumed by kbox's application-process prewarm protocol. */
export const KBOX_PREWARM_READY_MARKER = 'kbox-prewarm-ready-v1\n'

/**
 * Announce readiness only after the selected ACP profile has mounted.
 * Stderr keeps the ACP JSON-RPC stdout stream untouched.
 */
export function reportKboxPrewarmReady(
  env: NodeJS.ProcessEnv = process.env,
  write: (chunk: string) => unknown = (chunk) => process.stderr.write(chunk),
): void {
  if (env.KBOX_PREWARM_READY === '1') {
    write(KBOX_PREWARM_READY_MARKER)
  }
}
