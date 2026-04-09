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

/**
 * Create a drift detector backed by `git status --porcelain` over the given
 * working directory.
 *
 * Empty repos and non-git directories return `[]`. Any spawn or parse
 * failure also returns `[]` — drift detection is advisory and must not
 * abort the capture path.
 */
export function createGitStatusDriftDetector(cwd: string): DriftDetector {
  return {
    detect: async (): Promise<readonly string[]> => {
      try {
        const proc = Bun.spawn(["git", "status", "--porcelain"], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          return [];
        }
        const stdout = await new Response(proc.stdout).text();
        return parsePorcelain(stdout);
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
