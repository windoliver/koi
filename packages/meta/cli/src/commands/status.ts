/**
 * `koi status` — check service health.
 *
 * TODO(Phase 2i-3): Implement multi-wave parallel health probing
 * (health endpoint, admin API, Nexus, Temporal).
 * Reference: archive/v1/packages/meta/cli/src/commands/status.ts (574 LOC)
 */

import type { CliFlags } from "../args.js";
import { isStatusFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isStatusFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi status: service health probing coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
