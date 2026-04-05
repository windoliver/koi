/**
 * `koi start` — run agent in single-prompt mode.
 *
 * Phase 2i-2 stub: validates flags and exits 0 (intentional — start should not
 * break scripts until the engine harness lands in Phase 2i-3).
 *
 * TODO(Phase 2i-3): wire to @koi/engine harness for single-prompt execution.
 * Reference: archive/v1/packages/meta/cli/src/commands/start.ts (932 LOC, full impl)
 */

import type { CliFlags } from "../args.js";
import { isStartFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isStartFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi start: engine harness not yet implemented (Phase 2i-3)\n`);
  if (flags.manifest !== undefined) {
    process.stderr.write(`  manifest: ${flags.manifest}\n`);
  }
  // Fail closed: returning FAILURE until the engine harness exists prevents
  // automation or deploy hooks from treating a no-op as a successful agent start.
  return ExitCode.FAILURE;
}
