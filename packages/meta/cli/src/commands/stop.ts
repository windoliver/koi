/**
 * `koi stop` command — stop the deployed service and optionally the embed Nexus daemon.
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
import type { StopFlags } from "../args.js";

export async function runStop(flags: StopFlags): Promise<void> {
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

  const info = await manager.status(serviceName);
  if (info.status === "not-installed") {
    process.stderr.write(`Service "${serviceName}" is not installed.\n`);
  } else if (info.status !== "running") {
    process.stderr.write(`Service "${serviceName}" is already ${info.status}.\n`);
  } else {
    process.stderr.write(`Stopping "${serviceName}"...\n`);
    await manager.stop(serviceName);
    process.stderr.write(`Service "${serviceName}" stopped.\n`);
  }

  // Stop embed Nexus daemon if requested
  if (flags.nexus) {
    try {
      const { stopEmbedNexus } = await import("@koi/nexus-embed");
      const result = stopEmbedNexus();
      if (result.ok) {
        process.stderr.write(`Nexus embed daemon stopped (PID ${String(result.value.pid)}).\n`);
      } else {
        process.stderr.write(`Nexus embed: ${result.error.message}\n`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to stop Nexus embed: ${message}\n`);
    }
  }
}
