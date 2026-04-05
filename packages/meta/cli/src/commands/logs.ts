/**
 * `koi logs` — view service logs.
 *
 * TODO(Phase 2i-3): Tail logs from the running koi service.
 */

import type { CliFlags } from "../args.js";
import { isLogsFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isLogsFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi logs: log streaming coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
