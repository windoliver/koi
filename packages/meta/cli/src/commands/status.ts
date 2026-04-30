import type { CliFlags } from "../args.js";
import { isStatusFlags } from "../args.js";
import {
  probeServiceHealth,
  resolveServiceConfig,
  serviceHealthUrl,
  serviceStatus,
} from "../service-lifecycle.js";
import { ExitCode } from "../types.js";

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isStatusFlags(flags)) return ExitCode.FAILURE;
  const resolved = await resolveServiceConfig({
    manifest: flags.manifest,
    port: undefined,
    system: undefined,
  });
  if (!resolved.ok) {
    process.stderr.write(`koi status: ${resolved.error}\n`);
    return ExitCode.FAILURE;
  }

  const info = await serviceStatus(resolved.value);
  const health =
    info.status === "running"
      ? await probeServiceHealth(resolved.value, flags.timeout ?? 2_000)
      : undefined;

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({
        service: resolved.value.serviceName,
        status: info.status,
        pid: info.pid,
        uptimeMs: info.uptimeMs,
        memoryBytes: info.memoryBytes,
        healthUrl: serviceHealthUrl(resolved.value),
        health: health?.ok === true ? health.value : health?.error,
      })}\n`,
    );
  } else {
    process.stdout.write(`Service: ${resolved.value.serviceName}\n`);
    process.stdout.write(`Status:  ${info.status}\n`);
    if (info.pid !== undefined) process.stdout.write(`PID:     ${info.pid}\n`);
    process.stdout.write(`Health:  ${serviceHealthUrl(resolved.value)}\n`);
    if (health !== undefined) {
      const healthText = health.ok ? `${health.value.status ?? "unknown"}` : health.error;
      process.stdout.write(`Probe:   ${healthText}\n`);
    }
  }

  const healthy = info.status === "running" && health !== undefined && health.ok && health.value.ok;
  return healthy ? ExitCode.OK : ExitCode.FAILURE;
}
