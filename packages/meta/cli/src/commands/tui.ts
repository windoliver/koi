/**
 * `koi tui` — interactive terminal console.
 *
 * TODO(Phase 2i-3): Launch the TUI channel adapter.
 * Reference: packages/ui/tui
 */

import type { CliFlags } from "../args.js";
import { isTuiFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isTuiFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi tui: interactive console coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
