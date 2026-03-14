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

  // Nexus mode detection: read preset from manifest to show mode
  const nexusMode = await inferNexusMode(manifestPath);
  const nexusModeLabel = nexusMode !== undefined ? ` [${nexusMode}]` : "";
  process.stdout.write(
    `Nexus:    ${nexusOk ? "ready" : "not running"} (${nexusUrl})${nexusModeLabel}\n`,
  );

  // Temporal status: prefer admin API's SDK-based health check, fall back to direct probe
  const temporalHealth = await fetchTemporalHealth(adminUrl, adminOk);
  if (temporalHealth !== undefined) {
    const addrLabel = temporalHealth.serverAddress ?? "localhost:7233";
    const latencyLabel =
      temporalHealth.latencyMs !== undefined ? ` (${String(temporalHealth.latencyMs)}ms)` : "";
    process.stdout.write(`Temporal: ready (${addrLabel})${latencyLabel}\n`);
  }

  // Dispatched agents: probe admin API for active agent list
  if (adminOk) {
    const agents = await fetchDispatchedAgents(adminUrl);
    if (agents !== undefined && agents.length > 0) {
      process.stdout.write("Agents:\n");
      for (const agent of agents) {
        process.stdout.write(`  - ${agent.name} (${agent.state})\n`);
      }
    }
  }

  // Data sources: probe admin API, fall back to manifest
  if (adminOk) {
    const dataSources = await fetchDataSources(adminUrl);
    if (dataSources !== undefined && dataSources.length > 0) {
      process.stdout.write("Data Sources:\n");
      for (const ds of dataSources) {
        process.stdout.write(`  - ${ds.name} (${ds.protocol}) [${ds.status}]\n`);
      }
    }
  } else {
    // Fall back to manifest dataSources
    const manifestData = manifest as unknown as Record<string, unknown>;
    const manifestSources = manifestData.dataSources as
      | readonly { readonly name?: string; readonly protocol?: string }[]
      | undefined;
    if (manifestSources !== undefined && manifestSources.length > 0) {
      process.stdout.write("Data Sources:\n");
      for (const ds of manifestSources) {
        const name = typeof ds.name === "string" ? ds.name : "unknown";
        const protocol = typeof ds.protocol === "string" ? ds.protocol : "unknown";
        process.stdout.write(`  - ${name} (${protocol}) [configured]\n`);
      }
    }
  }

  // Channels: probe live state from admin API, fall back to manifest
  const channels = manifest.channels ?? [];
  if (channels.length > 0) {
    process.stdout.write("Channels:\n");

    if (adminOk) {
      const liveChannels = await fetchLiveChannels(adminUrl);
      if (liveChannels !== undefined) {
        for (const ch of liveChannels) {
          process.stdout.write(`  - ${ch.name} (${ch.status})\n`);
        }
      } else {
        for (const ch of channels) {
          process.stdout.write(`  - ${ch.name} (configured)\n`);
        }
      }
    } else {
      for (const ch of channels) {
        process.stdout.write(`  - ${ch.name} (configured)\n`);
      }
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

interface LiveChannel {
  readonly name: string;
  readonly status: string;
}

async function fetchLiveChannels(adminUrl: string): Promise<readonly LiveChannel[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/channels`, { signal: AbortSignal.timeout(2000) });
    if (res.status !== 200) return undefined;
    const data = (await res.json()) as readonly {
      readonly channelType?: string;
      readonly connected?: boolean;
    }[];
    return data.map((ch) => ({
      name: typeof ch.channelType === "string" ? ch.channelType : "unknown",
      status: ch.connected === true ? "connected" : "disconnected",
    }));
  } catch {
    return undefined;
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

interface TemporalHealthInfo {
  readonly healthy: boolean;
  readonly serverAddress?: string | undefined;
  readonly latencyMs?: number | undefined;
}

/**
 * Fetches Temporal health via the admin API's SDK-based health check.
 * Falls back to a direct HTTP probe if the admin API is unavailable.
 * Returns undefined when Temporal is not running.
 */
async function fetchTemporalHealth(
  adminUrl: string,
  adminAvailable: boolean,
): Promise<TemporalHealthInfo | undefined> {
  // Prefer admin API — it uses client.connection.healthCheck() internally
  if (adminAvailable) {
    try {
      const res = await fetch(`${adminUrl}/view/temporal/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) {
        const data = (await res.json()) as {
          readonly healthy?: boolean;
          readonly serverAddress?: string;
          readonly latencyMs?: number;
        };
        if (data.healthy === true) {
          return {
            healthy: true,
            serverAddress: data.serverAddress,
            latencyMs: data.latencyMs,
          };
        }
      }
      // 501 = not configured, other = admin doesn't know about Temporal;
      // fall through to direct probe (Temporal may still be running standalone)
    } catch {
      // Admin reachable but Temporal endpoint failed — fall through
    }
  }

  // Fallback: direct HTTP probe on Temporal dev server's HTTP API port
  const temporalHttpPort = 8233;
  try {
    const res = await fetch(`http://127.0.0.1:${String(temporalHttpPort)}/api/v1/namespaces`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      return { healthy: true, serverAddress: "localhost:7233" };
    }
  } catch {
    // Not running
  }
  return undefined;
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

/** Reads the preset field from the manifest to determine Nexus mode label. */
async function inferNexusMode(manifestPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const presetMatch = /^preset:\s*(\S+)/m.exec(raw);
    const presetId = presetMatch?.[1];
    if (presetId === "demo" || presetId === "mesh") return "embed-auth";
    if (presetId === "local") return "embed-lite";
    // Infer from demo.pack presence
    if (/^demo:\s*\n\s+pack:/m.test(raw)) return "embed-auth";
    return undefined;
  } catch {
    return undefined;
  }
}

interface DataSourceInfo {
  readonly name: string;
  readonly protocol: string;
  readonly status: string;
}

async function fetchDataSources(adminUrl: string): Promise<readonly DataSourceInfo[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/data-sources`, { signal: AbortSignal.timeout(2000) });
    if (res.status !== 200) return undefined;
    const data = (await res.json()) as {
      readonly ok?: boolean;
      readonly data?: readonly {
        readonly name?: string;
        readonly protocol?: string;
        readonly status?: string;
      }[];
    };
    if (data.ok !== true || data.data === undefined) return undefined;
    return data.data.map((ds) => ({
      name: typeof ds.name === "string" ? ds.name : "unknown",
      protocol: typeof ds.protocol === "string" ? ds.protocol : "unknown",
      status: typeof ds.status === "string" ? ds.status : "unknown",
    }));
  } catch {
    return undefined;
  }
}

interface DispatchedAgentInfo {
  readonly name: string;
  readonly state: string;
}

async function fetchDispatchedAgents(
  adminUrl: string,
): Promise<readonly DispatchedAgentInfo[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/agents`, { signal: AbortSignal.timeout(2000) });
    if (res.status !== 200) return undefined;
    // DashboardAgentSummary has `state: ProcessState`, not `status`
    const data = (await res.json()) as readonly {
      readonly name?: string;
      readonly state?: string;
    }[];
    return data.map((a) => ({
      name: typeof a.name === "string" ? a.name : "unknown",
      state: typeof a.state === "string" ? a.state : "running",
    }));
  } catch {
    return undefined;
  }
}
