/**
 * `koi tui` — interactive terminal console.
 *
 * TODO(Phase 2i-3): Launch the TUI channel adapter.
 * Reference: packages/ui/tui
 */

import type { TuiFlags } from "../args/tui.js";
import { ExitCode } from "../types.js";

export async function run(flags: TuiFlags): Promise<ExitCode> {
  process.stderr.write(`koi tui: interactive console coming in Phase 2i-3\n`);
  if (flags.agent !== undefined) {
    process.stderr.write(`  agent: ${flags.agent}\n`);
  }
  return ExitCode.FAILURE;
}
