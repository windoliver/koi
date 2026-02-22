/**
 * `koi status` command — check service status.
 */

import {
  createLaunchdManager,
  createSystemdManager,
  detectPlatform,
  resolveLogDir,
  resolveServiceName,
} from "@koi/deploy";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown/exit-codes";
import type { StatusFlags } from "../args.js";

export async function runStatus(flags: StatusFlags): Promise<void> {
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";

  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest } = loadResult.value;
  const platform = detectPlatform();
  const serviceName = resolveServiceName(manifest.name);
  const system = manifest.deploy?.system ?? false;
  const logDir = manifest.deploy?.logDir ?? resolveLogDir(platform, serviceName);

  const manager =
    platform === "linux" ? createSystemdManager(system) : createLaunchdManager(system, logDir);

  const status = await manager.status(serviceName);

  const healthPort = manifest.deploy?.port ?? 9100;
  const healthUrl = `http://localhost:${healthPort}/health`;

  process.stdout.write(`Agent:    ${manifest.name}\n`);
  process.stdout.write(`Service:  ${serviceName}\n`);
  process.stdout.write(`Platform: ${platform}\n`);
  process.stdout.write(`Status:   ${status}\n`);
  process.stdout.write(`Health:   ${healthUrl}\n`);

  // Try to check health endpoint if running
  if (status === "running") {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      process.stdout.write(`Health:   ${res.status === 200 ? "healthy" : "unhealthy"}\n`);
    } catch {
      process.stdout.write(`Health:   unreachable\n`);
    }
  }
}
