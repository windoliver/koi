import type { CliFlags } from "../args.js";
import { isLogsFlags } from "../args.js";
import { resolveServiceConfig, serviceLogs } from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isLogsFlags(flags)) return ExitCode.FAILURE;
  const resolved = await resolveServiceConfig({
    manifest: flags.manifest,
    port: undefined,
    system: undefined,
  });
  if (!resolved.ok) {
    process.stderr.write(`koi logs: ${resolved.error}\n`);
    return ExitCode.FAILURE;
  }

  try {
    for await (const chunk of serviceLogs(resolved.value, flags.lines, flags.follow)) {
      process.stdout.write(chunk);
    }
    return ExitCode.OK;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi logs: ${message}\n`);
    return ExitCode.FAILURE;
  }
}
