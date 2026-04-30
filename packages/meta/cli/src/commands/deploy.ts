import type { CliFlags } from "../args.js";
import { isDeployFlags } from "../args.js";
import {
  installService,
  resolveServiceConfig,
  serviceHealthUrl,
  uninstallService,
} from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isDeployFlags(flags)) return ExitCode.FAILURE;

  const resolved = await resolveServiceConfig({
    manifest: flags.manifest,
    port: flags.port,
    system: flags.system,
    validateManifest: !flags.uninstall,
  });
  if (!resolved.ok) {
    process.stderr.write(`koi deploy: ${resolved.error}\n`);
    return ExitCode.FAILURE;
  }

  try {
    if (flags.uninstall) {
      await uninstallService(resolved.value);
      process.stderr.write(`Removed service ${resolved.value.serviceName}.\n`);
      return ExitCode.OK;
    }

    await installService(resolved.value);
    process.stderr.write(`Installed service ${resolved.value.serviceName}.\n`);
    process.stderr.write(`Health: ${serviceHealthUrl(resolved.value)}\n`);
    process.stderr.write(`Logs:   ${resolved.value.logPath}\n`);
    return ExitCode.OK;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi deploy: ${message}\n`);
    return ExitCode.FAILURE;
  }
}
