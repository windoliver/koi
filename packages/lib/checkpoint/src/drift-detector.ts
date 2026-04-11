/**
 * Drift detector — runs `git status --porcelain` to surface filesystem
 * changes that did not come through the tracked tool pipeline (bash-mediated
 * `rm`, `mv`, `sed -i`, build artifacts, etc).
 *
 * Per the design review's drift contract (Issue 7A), drift is reported as
 * an advisory list on the snapshot but is NOT restored on rewind — the
 * rewind UI surfaces it so users know what their checkpoint cannot undo.
 *
 * Failure-tolerant by design: any error (no git, not a repo, permission
 * denied, timeout) returns an empty list rather than throwing. Drift
 * detection is advisory; it must never block capture.
 */

import type { DriftDetector } from "./types.js";

/** Default hard cap on git status runtime. Bounds `onAfterTurn` critical-path cost. */
export const DEFAULT_DRIFT_TIMEOUT_MS = 1500;

export interface GitStatusDriftDetectorOptions {
  /**
   * Override the executable used for status. Defaults to `"git"`. Test-only —
   * lets the timeout path be exercised with a synthetic hanging command
   * (e.g. `sleep 10`) without waiting for a real 1.5s git-status timeout.
   */
  readonly command?: readonly string[];
  /** Override the timeout cap. Defaults to {@link DEFAULT_DRIFT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Create a drift detector backed by `git status --porcelain` over the given
 * working directory.
 *
 * Empty repos and non-git directories return `[]`. Any spawn or parse
 * failure also returns `[]` — drift detection is advisory and must not
 * abort the capture path.
 *
 * Timeout: hard-capped at 1.5s via `Promise.race` + `proc.kill()`. A
 * hanging `git status` (enormous repo, corrupt index, etc.) will not
 * stall `onAfterTurn` — the detector gives up, kills the subprocess,
 * and returns an empty list.
 */
export function createGitStatusDriftDetector(
  cwd: string,
  options: GitStatusDriftDetectorOptions = {},
): DriftDetector {
  const command = options.command ?? (["git", "status", "--porcelain"] as const);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRIFT_TIMEOUT_MS;
  return {
    detect: async (): Promise<readonly string[]> => {
      try {
        const proc = Bun.spawn([...command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });

        // Race the process exit against a hard timeout. If the timer fires
        // first we forcibly kill the subprocess and treat the detection as
        // failed (return []). Without this, `proc.exited` could await
        // indefinitely on a hung command.
        // let: mutable — must clear on either outcome to avoid a leaked timer
        // biome-ignore lint/suspicious/noExplicitAny: Timer handle type varies across runtimes
        let timer: any;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        try {
          const winner = await Promise.race([
            proc.exited.then((code) => ({ kind: "exit" as const, code })),
            timeoutPromise.then(() => ({ kind: "timeout" as const })),
          ]);
          if (winner.kind === "timeout") {
            try {
              proc.kill();
            } catch {
              // Process already exited between the race and the kill — ignore.
            }
            return [];
          }
          if (winner.code !== 0) {
            return [];
          }
          const stdout = await new Response(proc.stdout).text();
          return parsePorcelain(stdout);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return [];
      }
    },
  };
}

/**
 * Parse `git status --porcelain` output into a list of one-line warnings.
 *
 * Each line is two status chars + space + path:
 *   "M  src/foo.ts"
 *   "?? generated/output.json"
 *   "AM src/bar.ts"
 *
 * We pass the lines through more-or-less verbatim — they're advisory and
 * already human-readable.
 */
export function parsePorcelain(output: string): readonly string[] {
  if (output.length === 0) return [];
  const lines = output.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    result.push(trimmed);
  }
  return result;
}
