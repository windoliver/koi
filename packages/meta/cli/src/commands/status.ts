/**
 * `koi status` command — unified health reporting for all subsystems.
 *
 * Detects what `koi up` launched and reports:
 * - Agent runtime status
 * - Nexus health
 * - Admin API health
 * - Channel connections
 * - PID file for detached mode
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  const workspaceRoot = resolve(dirname(manifestPath));

  // Basic agent info
  process.stdout.write(`Agent:    ${manifest.name}\n`);
  process.stdout.write(`Model:    ${manifest.model.name}\n`);

  // Check for koi up PID file
  const pidPath = join(workspaceRoot, ".koi", "koi.pid");
  const pid = await readPidFile(pidPath);
  if (pid !== undefined) {
    const alive = isProcessAlive(pid);
    process.stdout.write(`PID:      ${String(pid)} (${alive ? "running" : "stale"})\n`);
    if (!alive) {
      process.stdout.write(`hint: stale PID file at ${pidPath} — remove it or run \`koi up\`\n`);
    }
  }

  // OS service status
  const platform = detectPlatform();
  const serviceName = resolveServiceName(manifest.name);
  const system = manifest.deploy?.system ?? false;
  const logDir = manifest.deploy?.logDir ?? resolveLogDir(platform, serviceName);

  const manager =
    platform === "linux" ? createSystemdManager(system) : createLaunchdManager(system, logDir);

  const info = await manager.status(serviceName);

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

  // Health endpoints
  const healthPort = manifest.deploy?.port ?? 9100;
  const healthUrl = `http://localhost:${String(healthPort)}/health`;
  const adminUrl = "http://localhost:3100/admin/api";

  const nexusUrl = manifest.nexus?.url ?? process.env.NEXUS_URL ?? "http://127.0.0.1:2026";
  const nexusHealthUrl = `${nexusUrl}/health`;

  // Probe health endpoints concurrently
  const [healthOk, adminOk, nexusOk] = await Promise.all([
    probeEndpoint(healthUrl),
    probeEndpoint(adminUrl),
    probeEndpoint(nexusHealthUrl),
  ]);

  if (info.status === "running" || pid !== undefined) {
    process.stdout.write(`Health:   ${healthOk ? "healthy" : "unreachable"} (${healthUrl})\n`);
  }

  process.stdout.write(`Admin:    ${adminOk ? "ready" : "not running"}\n`);
  process.stdout.write(`Nexus:    ${nexusOk ? "ready" : "not running"} (${nexusUrl})\n`);

  // Channels from manifest (configured, not necessarily connected)
  const channels = manifest.channels ?? [];
  if (channels.length > 0) {
    process.stdout.write("Channels:\n");
    for (const ch of channels) {
      process.stdout.write(`  - ${ch.name} (configured)\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readPidFile(path: string): Promise<number | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

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
