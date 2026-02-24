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

/** Runtime error — restart may help. */
export const EXIT_ERROR = 1;

/** Dependency unavailable — retry later. */
export const EXIT_UNAVAILABLE = 69;

/** Configuration error — restart won't help. */
export const EXIT_CONFIG = 78;

/**
 * Map a KoiErrorCode string to a process exit code.
 *
 * - VALIDATION → EXIT_CONFIG (78): config / input error, restart won't help
 * - RATE_LIMIT, TIMEOUT → EXIT_UNAVAILABLE (69): transient, retry later
 * - Everything else → EXIT_ERROR (1): generic runtime failure
 *
 * Accepts `string` instead of `KoiErrorCode` to keep @koi/shutdown dependency-free.
 */
export function exitCodeForError(code: string): number {
  switch (code) {
    case "VALIDATION":
      return EXIT_CONFIG;
    case "RATE_LIMIT":
    case "TIMEOUT":
      return EXIT_UNAVAILABLE;
    default:
      return EXIT_ERROR;
  }
}
