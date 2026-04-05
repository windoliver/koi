/**
 * `koi serve` — run agent headless (for services).
 *
 * TODO(Phase 2i-3): Implement headless service mode.
 * Reference: archive/v1/packages/meta/cli/src/commands/start.ts
 */

import type { CliFlags } from "../args.js";
import { isServeFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isServeFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi serve: headless service mode coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
