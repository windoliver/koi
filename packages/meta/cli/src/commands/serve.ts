/**
 * `koi serve` — run agent headless (for services).
 *
 * TODO(Phase 2i-3): Implement headless service mode.
 * Reference: archive/v1/packages/meta/cli/src/commands/start.ts
 */

import type { ServeFlags } from "../args/serve.js";
import { ExitCode } from "../types.js";

export async function run(flags: ServeFlags): Promise<ExitCode> {
  process.stderr.write(`koi serve: headless service mode coming in Phase 2i-3\n`);
  if (flags.manifest !== undefined) {
    process.stderr.write(`  manifest: ${flags.manifest}\n`);
  }
  return ExitCode.FAILURE;
}
