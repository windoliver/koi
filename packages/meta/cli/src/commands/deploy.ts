/**
 * `koi deploy` — install/uninstall OS service (launchd / systemd).
 *
 * TODO(Phase 2i-3): Implement OS service registration.
 * Reference: archive/v1/packages/meta/cli/src/commands/start.ts (deploy section)
 */

import type { CliFlags } from "../args.js";
import { isDeployFlags } from "../args.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isDeployFlags(flags)) return ExitCode.FAILURE;
  process.stderr.write(`koi deploy: OS service registration coming in Phase 2i-3\n`);
  return ExitCode.FAILURE;
}
