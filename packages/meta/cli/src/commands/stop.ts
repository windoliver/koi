/**
 * `koi stop` — graceful shutdown.
 *
 * TODO(Phase 2i-3): Implement graceful shutdown (OS service stop, PID file,
 * Nexus container lifecycle).
 * Reference: archive/v1/packages/meta/cli/src/commands/stop.ts (112 LOC)
 */

import type { CliFlags } from "../args.js";
import { isStopFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isStopFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi stop: graceful shutdown coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
