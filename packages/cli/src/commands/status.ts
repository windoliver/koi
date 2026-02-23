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

  const info = await manager.status(serviceName);

  const healthPort = manifest.deploy?.port ?? 9100;
  const healthUrl = `http://localhost:${healthPort}/health`;

  process.stdout.write(`Agent:    ${manifest.name}\n`);
  process.stdout.write(`Service:  ${serviceName}\n`);
  process.stdout.write(`Platform: ${platform}\n`);
  process.stdout.write(`Status:   ${info.status}\n`);

  if (info.pid !== undefined) {
    process.stdout.write(`PID:      ${info.pid}\n`);
  }
  if (info.uptimeMs !== undefined) {
    process.stdout.write(`Uptime:   ${formatUptime(info.uptimeMs)}\n`);
  }
  if (info.memoryBytes !== undefined) {
    process.stdout.write(`Memory:   ${formatMemory(info.memoryBytes)}\n`);
  }

  process.stdout.write(`Health:   ${healthUrl}\n`);

  // Try to check health endpoint if running
  if (info.status === "running") {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      process.stdout.write(`Health:   ${res.status === 200 ? "healthy" : "unhealthy"}\n`);
    } catch {
      process.stdout.write(`Health:   unreachable\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
