/**
 * `koi status` command — unified health reporting for all subsystems.
 *
 * Detects what `koi up` launched and reports:
 * - Agent runtime status
 * - Nexus health
 * - Admin API health
 * - Channel connections
 * - PID file for detached mode
 *
 * Probes run in parallel where possible:
 *   Wave 1 (parallel): health, admin port detection, Nexus, Temporal direct
 *   Wave 2 (parallel, only if admin is up): agents, data sources, channels
 *
 * Supports `--json` for structured output suitable for scripting.
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
import { EXIT_ERROR, EXIT_OK } from "@koi/shutdown";
import type { StatusFlags } from "../args.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

/** Default timeout for all status probes (ms). Override with `--timeout`. */
const DEFAULT_PROBE_TIMEOUT = 2000;

// ---------------------------------------------------------------------------
// JSON output types
// ---------------------------------------------------------------------------

interface StatusJsonOutput {
  readonly agent: string;
  readonly model: string;
  readonly pid: { readonly value: number; readonly alive: boolean } | null;
  readonly service: {
    readonly name: string;
    readonly platform: string;
    readonly status: string;
    readonly pid: number | undefined;
    readonly uptimeMs: number | undefined;
    readonly memoryBytes: number | undefined;
  };
  readonly health: { readonly ok: boolean; readonly url: string } | null;
  readonly admin: { readonly ok: boolean; readonly port: number };
  readonly nexus: { readonly ok: boolean; readonly url: string; readonly mode: string | null };
  readonly temporal: TemporalHealthInfo | null;
  readonly agents: readonly DispatchedAgentInfo[] | null;
  readonly dataSources: readonly DataSourceInfo[] | null;
  readonly channels: readonly LiveChannel[] | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runStatus(flags: StatusFlags): Promise<void> {
  const probeTimeout = flags.timeout ?? DEFAULT_PROBE_TIMEOUT;
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);
  const workspaceRoot = resolve(dirname(manifestPath));

  // Check for koi up PID file
  const pidPath = join(workspaceRoot, ".koi", "koi.pid");
  const pid = await readPidFile(pidPath);
  const pidAlive = pid !== undefined ? isProcessAlive(pid) : false;

  // OS service status
  const platform = detectPlatform();
  const serviceName = resolveServiceName(manifest.name);
  const system = manifest.deploy?.system ?? false;
  const logDir = manifest.deploy?.logDir ?? resolveLogDir(platform, serviceName);

  const manager =
    platform === "linux" ? createSystemdManager(system) : createLaunchdManager(system, logDir);

  const info = await manager.status(serviceName);

  // Health endpoints
  const healthPort = manifest.deploy?.port ?? 9100;
  const healthUrl = `http://localhost:${String(healthPort)}/health`;
  const nexusUrl = manifest.nexus?.url ?? process.env.NEXUS_URL ?? "http://127.0.0.1:2026";
  const nexusHealthUrl = `${nexusUrl}/health`;

  // Wave 1: probe independent endpoints in parallel
  const wave1 = await probeWave1({ healthUrl, nexusHealthUrl, probeTimeout });

  const adminUrl = `http://localhost:${String(wave1.adminPort)}/admin/api`;

  // Nexus mode detection
  const nexusMode = await inferNexusMode(manifestPath);

  // Temporal: prefer admin API health, fall back to direct probe result from wave 1
  const temporalHealth = wave1.adminOk
    ? await fetchTemporalHealthViaAdmin(adminUrl, probeTimeout)
    : undefined;
  const effectiveTemporal = temporalHealth ?? wave1.temporalDirect;

  // Wave 2: admin detail fetches — only if admin is reachable (short-circuit)
  const wave2 = wave1.adminOk
    ? await probeWave2(adminUrl, probeTimeout)
    : { agents: undefined, dataSources: undefined, channels: undefined };

  // JSON output mode
  if (flags.json) {
    const result: StatusJsonOutput = {
      agent: manifest.name,
      model: manifest.model.name,
      pid: pid !== undefined ? { value: pid, alive: pidAlive } : null,
      service: {
        name: serviceName,
        platform,
        status: info.status,
        pid: info.pid,
        uptimeMs: info.uptimeMs,
        memoryBytes: info.memoryBytes,
      },
      health:
        info.status === "running" || pid !== undefined
          ? { ok: wave1.healthOk, url: healthUrl }
          : null,
      admin: { ok: wave1.adminOk, port: wave1.adminPort },
      nexus: { ok: wave1.nexusOk, url: nexusUrl, mode: nexusMode ?? null },
      temporal: effectiveTemporal ?? null,
      agents: wave2.agents ?? null,
      dataSources: wave2.dataSources ?? null,
      channels: wave2.channels ?? null,
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    // Exit with error if any critical subsystem is down
    const healthy = wave1.healthOk || info.status === "running";
    process.exit(healthy ? EXIT_OK : EXIT_ERROR);
    return;
  }

  // Text output mode (default)
  process.stdout.write(`Agent:    ${manifest.name}\n`);
  process.stdout.write(`Model:    ${manifest.model.name}\n`);

  if (pid !== undefined) {
    process.stdout.write(`PID:      ${String(pid)} (${pidAlive ? "running" : "stale"})\n`);
    if (!pidAlive) {
      process.stdout.write(`hint: stale PID file at ${pidPath} — remove it or run \`koi up\`\n`);
    }
  }

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

  if (info.status === "running" || pid !== undefined) {
    process.stdout.write(
      `Health:   ${wave1.healthOk ? "healthy" : "unreachable"} (${healthUrl})\n`,
    );
  }

  process.stdout.write(`Admin:    ${wave1.adminOk ? "ready" : "not running"}\n`);

  const nexusModeLabel = nexusMode !== undefined ? ` [${nexusMode}]` : "";
  process.stdout.write(
    `Nexus:    ${wave1.nexusOk ? "ready" : "not running"} (${nexusUrl})${nexusModeLabel}\n`,
  );

  if (effectiveTemporal !== undefined) {
    const addrLabel = effectiveTemporal.serverAddress ?? "localhost:7233";
    const latencyLabel =
      effectiveTemporal.latencyMs !== undefined
        ? ` (${String(effectiveTemporal.latencyMs)}ms)`
        : "";
    process.stdout.write(`Temporal: ready (${addrLabel})${latencyLabel}\n`);
  }

  renderAgents(wave2.agents);
  renderDataSources(wave2.dataSources, manifest);
  renderChannels(wave2.channels, manifest.channels ?? []);
}

// ---------------------------------------------------------------------------
// Wave 1 — independent probes (health, admin detect, Nexus, Temporal direct)
// ---------------------------------------------------------------------------

interface Wave1Result {
  readonly healthOk: boolean;
  readonly adminPort: number;
  readonly adminOk: boolean;
  readonly nexusOk: boolean;
  readonly temporalDirect: TemporalHealthInfo | undefined;
}

async function probeWave1(opts: {
  readonly healthUrl: string;
  readonly nexusHealthUrl: string;
  readonly probeTimeout: number;
}): Promise<Wave1Result> {
  const [healthResult, adminResult, nexusResult, temporalResult] = await Promise.allSettled([
    probeEndpoint(opts.healthUrl, opts.probeTimeout),
    detectAdminPort(opts.probeTimeout),
    probeEndpoint(opts.nexusHealthUrl, opts.probeTimeout),
    probeTemporalDirect(opts.probeTimeout),
  ]);

  const healthOk = healthResult.status === "fulfilled" && healthResult.value;
  const adminPort = adminResult.status === "fulfilled" ? adminResult.value.port : 3100;
  const adminOk = adminResult.status === "fulfilled" && adminResult.value.ok;
  const nexusOk = nexusResult.status === "fulfilled" && nexusResult.value;
  const temporalDirect = temporalResult.status === "fulfilled" ? temporalResult.value : undefined;

  return { healthOk, adminPort, adminOk, nexusOk, temporalDirect };
}

// ---------------------------------------------------------------------------
// Wave 2 — admin-dependent detail fetches (short-circuited when admin is down)
// ---------------------------------------------------------------------------

interface Wave2Result {
  readonly agents: readonly DispatchedAgentInfo[] | undefined;
  readonly dataSources: readonly DataSourceInfo[] | undefined;
  readonly channels: readonly LiveChannel[] | undefined;
}

async function probeWave2(adminUrl: string, timeout: number): Promise<Wave2Result> {
  const [agentsResult, dsResult, channelsResult] = await Promise.allSettled([
    fetchDispatchedAgents(adminUrl, timeout),
    fetchDataSources(adminUrl, timeout),
    fetchLiveChannels(adminUrl, timeout),
  ]);

  return {
    agents: agentsResult.status === "fulfilled" ? agentsResult.value : undefined,
    dataSources: dsResult.status === "fulfilled" ? dsResult.value : undefined,
    channels: channelsResult.status === "fulfilled" ? channelsResult.value : undefined,
  };
}

// ---------------------------------------------------------------------------
// Renderers — keep output logic out of main flow
// ---------------------------------------------------------------------------

function renderAgents(agents: readonly DispatchedAgentInfo[] | undefined): void {
  if (agents !== undefined && agents.length > 0) {
    process.stdout.write("Agents:\n");
    for (const agent of agents) {
      process.stdout.write(`  - ${agent.name} (${agent.state})\n`);
    }
  }
}

function renderDataSources(
  live: readonly DataSourceInfo[] | undefined,
  manifest: { readonly dataSources?: unknown },
): void {
  if (live !== undefined && live.length > 0) {
    process.stdout.write("Data Sources:\n");
    for (const ds of live) {
      const fitnessLabel =
        ds.fitness !== undefined
          ? ` ${String(Math.round(ds.fitness.successRate * 100))}% success, ${String(ds.fitness.successCount + ds.fitness.errorCount)} queries${ds.fitness.p95LatencyMs !== undefined ? `, p95: ${String(ds.fitness.p95LatencyMs)}ms` : ""}`
          : "";
      process.stdout.write(`  - ${ds.name} (${ds.protocol}) [${ds.status}]${fitnessLabel}\n`);
    }
    return;
  }

  // Fall back to manifest dataSources when admin is down or returns empty
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

function renderChannels(
  live: readonly LiveChannel[] | undefined,
  manifestChannels: readonly { readonly name: string }[],
): void {
  if (manifestChannels.length === 0) return;

  process.stdout.write("Channels:\n");
  if (live !== undefined) {
    for (const ch of live) {
      process.stdout.write(`  - ${ch.name} (${ch.status})\n`);
    }
  } else {
    for (const ch of manifestChannels) {
      process.stdout.write(`  - ${ch.name} (configured)\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

async function probeEndpoint(url: string, timeout: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.status === 200;
  } catch {
    return false;
  }
}

interface AdminDetectResult {
  readonly port: number;
  readonly ok: boolean;
}

/** Scan ports 3100-3109 to find the running admin API. */
async function detectAdminPort(timeout: number): Promise<AdminDetectResult> {
  for (let port = 3100; port < 3110; port++) {
    try {
      const res = await fetch(`http://localhost:${String(port)}/admin/api/health`, {
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 200) return { port, ok: true };
    } catch {
      // Port not responding, try next
    }
  }
  return { port: 3100, ok: false };
}

// ---------------------------------------------------------------------------
// Temporal probes
// ---------------------------------------------------------------------------

interface TemporalHealthInfo {
  readonly healthy: boolean;
  readonly serverAddress?: string | undefined;
  readonly latencyMs?: number | undefined;
}

/** Direct HTTP probe on Temporal dev server's HTTP API port. */
async function probeTemporalDirect(timeout: number): Promise<TemporalHealthInfo | undefined> {
  const temporalHttpPort = 8233;
  try {
    const res = await fetch(`http://127.0.0.1:${String(temporalHttpPort)}/api/v1/namespaces`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      return { healthy: true, serverAddress: "localhost:7233" };
    }
  } catch {
    // Not running
  }
  return undefined;
}

/**
 * Fetches Temporal health via the admin API's SDK-based health check.
 * Returns undefined when the admin API does not report Temporal as healthy.
 */
async function fetchTemporalHealthViaAdmin(
  adminUrl: string,
  timeout: number,
): Promise<TemporalHealthInfo | undefined> {
  try {
    const res = await fetch(`${adminUrl}/view/temporal/health`, {
      signal: AbortSignal.timeout(timeout),
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
  } catch {
    // Admin reachable but Temporal endpoint failed
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Admin API detail fetchers
// ---------------------------------------------------------------------------

interface LiveChannel {
  readonly name: string;
  readonly status: string;
}

async function fetchLiveChannels(
  adminUrl: string,
  timeout: number,
): Promise<readonly LiveChannel[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/channels`, { signal: AbortSignal.timeout(timeout) });
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

interface DataSourceInfo {
  readonly name: string;
  readonly protocol: string;
  readonly status: string;
  readonly fitness?: {
    readonly successCount: number;
    readonly errorCount: number;
    readonly successRate: number;
    readonly p95LatencyMs: number | undefined;
  };
}

async function fetchDataSources(
  adminUrl: string,
  timeout: number,
): Promise<readonly DataSourceInfo[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/data-sources`, { signal: AbortSignal.timeout(timeout) });
    if (res.status !== 200) return undefined;
    const data = (await res.json()) as {
      readonly ok?: boolean;
      readonly data?: readonly {
        readonly name?: string;
        readonly protocol?: string;
        readonly status?: string;
        readonly fitness?: {
          readonly successCount?: number;
          readonly errorCount?: number;
          readonly successRate?: number;
          readonly p95LatencyMs?: number;
        };
      }[];
    };
    if (data.ok !== true || data.data === undefined) return undefined;
    return data.data.map((ds) => ({
      name: typeof ds.name === "string" ? ds.name : "unknown",
      protocol: typeof ds.protocol === "string" ? ds.protocol : "unknown",
      status: typeof ds.status === "string" ? ds.status : "unknown",
      ...(ds.fitness !== undefined
        ? {
            fitness: {
              successCount: ds.fitness.successCount ?? 0,
              errorCount: ds.fitness.errorCount ?? 0,
              successRate: ds.fitness.successRate ?? 0,
              p95LatencyMs: ds.fitness.p95LatencyMs,
            },
          }
        : {}),
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
  timeout: number,
): Promise<readonly DispatchedAgentInfo[] | undefined> {
  try {
    const res = await fetch(`${adminUrl}/agents`, { signal: AbortSignal.timeout(timeout) });
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

// ---------------------------------------------------------------------------
// Utility helpers
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
