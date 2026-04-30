import type { CliFlags } from "../args.js";
import { isStopFlags } from "../args.js";
import { resolveServiceConfig, stopService } from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isStopFlags(flags)) return ExitCode.FAILURE;
  const resolved = await resolveServiceConfig({
    manifest: flags.manifest,
    port: undefined,
    system: undefined,
  });
  if (!resolved.ok) {
    process.stderr.write(`koi stop: ${resolved.error}\n`);
    return ExitCode.FAILURE;
  }

  try {
    await stopService(resolved.value);
    process.stderr.write(`Stopped service ${resolved.value.serviceName}.\n`);
    return ExitCode.OK;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi stop: ${message}\n`);
    return ExitCode.FAILURE;
  }
}
