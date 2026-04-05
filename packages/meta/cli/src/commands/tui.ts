/**
 * `koi tui` — interactive terminal console.
 */

import type { CliFlags } from "../args.js";
import { isTuiFlags } from "../args.js";
import { runTuiCommand } from "../tui-command.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isTuiFlags(flags)) return ExitCode.FAILURE;
  await runTuiCommand(flags);
  return ExitCode.OK;
}
