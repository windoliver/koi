/**
 * `koi init` — scaffold a new agent manifest.
 *
 * TODO(Phase 2i-3): Implement interactive wizard (template selection,
 * model config, API key entry, manifest scaffolding).
 * Reference: archive/v1/packages/meta/cli/src/commands/init.ts
 */

import type { CliFlags } from "../args.js";
import { isInitFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isInitFlags(flags)) return ExitCode.FAILURE;
  const dir = flags.directory ?? ".";
  process.stderr.write(`koi init ${dir}: interactive wizard coming in Phase 2i-3\n`);
  process.stderr.write(`  Planned: select template → configure model → scaffold koi.yaml\n`);
  return ExitCode.FAILURE;
}
