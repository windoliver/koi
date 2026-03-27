/**
 * Process exit codes — sysexits.h-inspired constants.
 *
 * Used by service managers to decide restart behavior.
 * - EXIT_CONFIG (78) → RestartPreventExitStatus in systemd (won't restart on config errors)
 * - EXIT_ERROR (1) → restart appropriate
 * - EXIT_UNAVAILABLE (69) → retry later
 */

/** Clean exit — no errors. */
export const EXIT_OK = 0;

/** Runtime error (agent crash, subsystem failure) — restart may help. */
export const EXIT_ERROR = 1;

/** Network error (HTTP timeouts, registry unreachable). */
export const EXIT_NETWORK = 3;

/** Operation timeout (probe timeouts, deadline exceeded). */
export const EXIT_TIMEOUT = 4;

/** Dependency unavailable — retry later. */
export const EXIT_UNAVAILABLE = 69;

/** Configuration error (manifest errors, bad flags) — restart won't help. */
export const EXIT_CONFIG = 78;

/**
 * All exit codes as a lookup object for iteration / validation.
 */
export const EXIT_CODES: {
  readonly OK: typeof EXIT_OK;
  readonly ERROR: typeof EXIT_ERROR;
  readonly NETWORK: typeof EXIT_NETWORK;
  readonly TIMEOUT: typeof EXIT_TIMEOUT;
  readonly UNAVAILABLE: typeof EXIT_UNAVAILABLE;
  readonly CONFIG: typeof EXIT_CONFIG;
} = {
  OK: EXIT_OK,
  ERROR: EXIT_ERROR,
  NETWORK: EXIT_NETWORK,
  TIMEOUT: EXIT_TIMEOUT,
  UNAVAILABLE: EXIT_UNAVAILABLE,
  CONFIG: EXIT_CONFIG,
} as const;

/**
 * Map a KoiErrorCode string to a process exit code.
 *
 * - VALIDATION → EXIT_CONFIG (78): config / input error, restart won't help
 * - RATE_LIMIT → EXIT_UNAVAILABLE (69): transient, retry later
 * - TIMEOUT → EXIT_TIMEOUT (4): operation timed out
 * - EXTERNAL → EXIT_NETWORK (3): external service failure
 * - Everything else → EXIT_ERROR (1): generic runtime failure
 *
 * Accepts `string` instead of `KoiErrorCode` to keep @koi/shutdown dependency-free.
 */
export function exitCodeForError(code: string): number {
  switch (code) {
    case "VALIDATION":
      return EXIT_CONFIG;
    case "RATE_LIMIT":
      return EXIT_UNAVAILABLE;
    case "TIMEOUT":
      return EXIT_TIMEOUT;
    case "EXTERNAL":
      return EXIT_NETWORK;
    default:
      return EXIT_ERROR;
  }
}
