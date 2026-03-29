/**
 * `koi up` command — single command to start runtime + admin + TUI.
 *
 * Phases are extracted into individual modules under commands/up/.
 * This orchestrator wires them together with spinners and colored output.
 */

import { dirname, resolve } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import { createCliOutput, createTimer } from "@koi/cli-render";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineInput, InboundMessage } from "@koi/core";
import { brickId } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { AgentCostEntry, CostSnapshot, DashboardEvent } from "@koi/dashboard-types";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { getEngineName, loadManifest } from "@koi/manifest";
import { createDefaultCostCalculator } from "@koi/middleware-pay";
import { resolveRuntimePreset } from "@koi/runtime-presets";
import { EXIT_CONFIG } from "@koi/shutdown";
import { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { AgentChatBridge } from "../../agui-chat-bridge.js";
import type { UpFlags } from "../../args.js";
import { bootstrapForgeOrWarn } from "../../bootstrap-forge.js";
import { createChatRouter } from "../../chat-router.js";
import { collectSubsystemMiddleware, composeRuntimeMiddleware } from "../../compose-middleware.js";
import { createContextArenaConfigForUp } from "../../context-arena-config.js";
import type { StackContribution } from "../../contribution-graph.js";
import { addPostCompositionContributions } from "../../contribution-graph.js";
import { buildDebugExtraItems, collectActiveSubsystems } from "../../debug-inventory-items.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchangeSafely,
  resolveDashboardAssetsDir,
} from "../../helpers.js";
import { renderEvent } from "../../render-event.js";
import { formatResolutionError, resolveAgent } from "../../resolve-agent.js";
import { resolveAutonomousOrWarn } from "../../resolve-autonomous.js";
import { mergeBootstrapContext } from "../../resolve-bootstrap.js";
import { resolveNexusOrWarn, runNexusBuildIfNeeded } from "../../resolve-nexus.js";
import { resolveOrchestrationFromAgent } from "../../resolve-orchestration.js";
import { resolveTemporalOrWarn } from "../../resolve-temporal.js";
import {
  clearTerminalState,
  restoreCrashedTerminal,
  saveTerminalState,
} from "../../terminal-state.js";
import { printBanner } from "./banner.js";
import { createInteractiveConsent } from "./consent.js";
import { buildDemoManifestOverrides, provisionDemoAgents, seedDemoPackIfNeeded } from "./demo.js";
import { runDetach } from "./detach.js";
import { detectOrphanedNexusStacks } from "./detect-orphaned-nexus.js";
import { mapNexusModeToProfile, startNexusStack } from "./nexus.js";
import { runPreflight } from "./preflight.js";
import { extractDemoPack, extractStacks, inferPresetId } from "./preset.js";
import { activatePresetStacks } from "./stacks.js";
import { startTemporalEmbed } from "./temporal.js";

/**
 * Known manifest tool packages and their dynamic import + provider factory.
 * Each entry maps a package name to a function that creates a ComponentProvider.
 */
const TOOL_FACTORIES: Readonly<
  Record<string, (verbose: boolean) => Promise<import("@koi/core").ComponentProvider | undefined>>
> = {
  "@koi/tools-web": async (verbose) => {
    try {
      const { createWebProvider, createWebExecutor } = await import("@koi/tools-web");
      const braveKey = process.env.BRAVE_API_KEY;
      // Build search provider from Brave if API key is available
      const config: Record<string, unknown> = {};
      if (braveKey !== undefined && braveKey !== "") {
        try {
          const mod = await import("@koi/search-brave").catch(() => undefined);
          if (mod !== undefined) {
            config.searchProvider = mod.createBraveSearch({ apiKey: braveKey });
          }
        } catch {
          // search-brave not available — web_fetch still works
        }
      }
      const executor = createWebExecutor(config as Parameters<typeof createWebExecutor>[0]);
      const provider = createWebProvider({ executor });
      if (verbose) process.stderr.write("  Tool: @koi/tools-web (web_fetch, web_search)\n");
      return provider;
    } catch {
      return undefined;
    }
  },
  "@koi/tool-ask-user": async () => {
    // ask_user requires an ElicitationHandler wired to the TUI/channel.
    // Skip in manifest resolution — it's provided by the engine adapter when available.
    return undefined;
  },
  "@koi/tool-exec": async (verbose) => {
    try {
      const { createExecProvider } = await import("@koi/tool-exec");
      const { createWasmSandboxExecutor } = await import("@koi/sandbox-wasm");
      const executor = createWasmSandboxExecutor();
      const provider = createExecProvider({ executor });
      if (verbose) process.stderr.write("  Tool: @koi/tool-exec (wasm sandbox)\n");
      return provider;
    } catch {
      return undefined;
    }
  },
  "@koi/tool-browser": async (verbose) => {
    try {
      const { createBrowserProvider } = await import("@koi/tool-browser");
      const { createPlaywrightBrowserDriver } = await import("@koi/browser-playwright");
      const driver = await createPlaywrightBrowserDriver({ headless: true, stealth: true });
      const provider = createBrowserProvider({ backend: driver });
      if (verbose)
        process.stderr.write(
          "  Tool: @koi/tool-browser (browser_navigate, browser_snapshot, ...)\n",
        );
      return provider;
    } catch {
      return undefined;
    }
  },
  "@koi/tools-context-hub": async () => {
    // Context-hub tools are already provided by the contextHub stack activation.
    // Skip to avoid duplicate registration.
    return undefined;
  },
  "@koi/tools-github": async (verbose) => {
    try {
      const { createGithubProvider, createGhExecutor } = await import("@koi/tools-github");
      const executor = await createGhExecutor();
      const provider = createGithubProvider({ executor });
      if (verbose) process.stderr.write("  Tool: @koi/tools-github (pr_create, pr_status, ...)\n");
      return provider;
    } catch {
      return undefined;
    }
  },
};

/**
 * Resolves manifest tools (declared under tools.koi in koi.yaml) into
 * ComponentProviders by dynamically importing known tool packages.
 */
async function resolveManifestTools(
  manifest: import("@koi/core").AgentManifest,
  verbose: boolean,
): Promise<readonly import("@koi/core").ComponentProvider[]> {
  const tools = manifest.tools ?? [];
  const providers: import("@koi/core").ComponentProvider[] = [];

  for (const tool of tools) {
    const factory = TOOL_FACTORIES[tool.name];
    if (factory !== undefined) {
      const provider = await factory(verbose);
      if (provider !== undefined) providers.push(provider);
    }
  }

  return providers;
}

const LABEL_RE = /^\[(user|assistant|system)\]:\s*/;

/**
 * Expand stateless-normalized content blocks into separate InboundMessages.
 * Splits `[user]: ...` / `[assistant]: ...` labeled blocks back into
 * individual messages so the engine sends proper multi-turn conversation.
 */
function expandLabeledBlocks(msg: InboundMessage): readonly InboundMessage[] {
  const blocks = msg.content.filter(
    (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
  );
  if (blocks.length === 0 || !LABEL_RE.test(blocks[0]?.text ?? "")) {
    return [msg];
  }
  return blocks.map((block) => {
    const match = LABEL_RE.exec(block.text);
    const role = match?.[1] ?? "user";
    const text = block.text.replace(LABEL_RE, "");
    return {
      content: [{ kind: "text" as const, text }],
      senderId: role === "assistant" ? "assistant" : (msg.senderId ?? msg.threadId),
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      timestamp: msg.timestamp,
      metadata: { ...msg.metadata, role },
    };
  });
}

/** Creates a forge view data source from a ForgeStore + optional seeded bricks. */
function createForgeViewSource(
  store: import("@koi/core").ForgeStore,
  seededBricks: readonly import("@koi/dashboard-types").ForgeBrickView[],
  seededForgeEvents: readonly Readonly<Record<string, unknown>>[],
): {
  readonly listBricks: () => Promise<readonly import("@koi/dashboard-types").ForgeBrickView[]>;
  readonly getStats: () => Promise<import("@koi/dashboard-types").ForgeStats>;
  readonly listRecentEvents: () => Promise<
    readonly import("@koi/dashboard-types").ForgeDashboardEvent[]
  >;
} {
  return {
    async listBricks() {
      const result = await store.search({});
      const liveBricks: import("@koi/dashboard-types").ForgeBrickView[] = result.ok
        ? result.value.map((brick) => ({
            brickId: brick.id,
            name: brick.name,
            status: mapLifecycleToStatus(brick.lifecycle),
            fitness: brick.fitness?.successCount
              ? brick.fitness.successCount / (brick.fitness.successCount + brick.fitness.errorCount)
              : 0,
            sampleCount: (brick.fitness?.successCount ?? 0) + (brick.fitness?.errorCount ?? 0),
            createdAt: brick.provenance.metadata.startedAt,
            lastUpdatedAt: brick.fitness?.lastUsedAt ?? brick.provenance.metadata.startedAt,
          }))
        : [];

      if (liveBricks.length > 0) return liveBricks;
      // Fall back to seeded brick data from demo packs
      return seededBricks;
    },
    async getStats() {
      const result = await store.search({});
      const liveBricks = result.ok ? result.value : [];

      if (liveBricks.length > 0) {
        return {
          totalBricks: liveBricks.length,
          activeBricks: liveBricks.filter((b) => b.lifecycle === "active").length,
          demandSignals: 0,
          crystallizeCandidates: 0,
          timestamp: Date.now(),
        };
      }

      // Fall back to seeded brick data
      return {
        totalBricks: seededBricks.length,
        activeBricks: seededBricks.filter((b) => b.status === "active").length,
        demandSignals: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "demand_detected",
        ).length,
        crystallizeCandidates: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "crystallize_candidate",
        ).length,
        timestamp: Date.now(),
      };
    },
    async listRecentEvents() {
      // Seeded forge events are typed as ForgeDashboardEvent
      return seededForgeEvents as unknown as import("@koi/dashboard-types").ForgeDashboardEvent[];
    },
  };
}

/** Creates a forge view source backed only by seeded data (no live ForgeStore). */
function createSeededOnlyForgeViewSource(
  seededBricks: readonly import("@koi/dashboard-types").ForgeBrickView[],
  seededForgeEvents: readonly Readonly<Record<string, unknown>>[],
): {
  readonly listBricks: () => Promise<readonly import("@koi/dashboard-types").ForgeBrickView[]>;
  readonly getStats: () => Promise<import("@koi/dashboard-types").ForgeStats>;
  readonly listRecentEvents: () => Promise<
    readonly import("@koi/dashboard-types").ForgeDashboardEvent[]
  >;
} {
  return {
    async listBricks() {
      return seededBricks;
    },
    async getStats() {
      return {
        totalBricks: seededBricks.length,
        activeBricks: seededBricks.filter((b) => b.status === "active").length,
        demandSignals: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "demand_detected",
        ).length,
        crystallizeCandidates: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "crystallize_candidate",
        ).length,
        timestamp: Date.now(),
      };
    },
    async listRecentEvents() {
      return seededForgeEvents as unknown as import("@koi/dashboard-types").ForgeDashboardEvent[];
    },
  };
}

function mapLifecycleToStatus(
  lifecycle: string,
): "active" | "deprecated" | "promoted" | "quarantined" {
  switch (lifecycle) {
    case "active":
      return "active";
    case "deprecated":
      return "deprecated";
    case "promoted":
      return "promoted";
    case "quarantined":
      return "quarantined";
    default:
      return "active";
  }
}

/** Captures probeEnv in a closure to avoid L2→L2 import in the bridge. */
function createProbeCallback(
  probeEnv: (
    env: Readonly<Record<string, string | undefined>>,
    patterns: readonly string[],
  ) => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[],
): () => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[] {
  return () =>
    probeEnv(process.env as Readonly<Record<string, string | undefined>>, [
      "*DATABASE_URL*",
      "*_DSN",
      "*_CONNECTION_STRING",
    ]);
}

/** Create the VFS backend — Nexus agent namespace when available, local fallback. */
async function createVfsBackend(
  workspaceRoot: string,
  nexusBaseUrl: string | undefined,
  agentName: string,
): Promise<{
  readonly fs: import("@koi/core").FileSystemBackend;
  readonly backend: "nexus" | "local";
}> {
  if (nexusBaseUrl !== undefined) {
    try {
      const { createNexusFileSystem } = await import("@koi/filesystem-nexus");
      const { createNexusClient } = await import("@koi/nexus-client");
      const apiKey = process.env.NEXUS_API_KEY;
      const client = createNexusClient({
        baseUrl: nexusBaseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      const nexusFs = createNexusFileSystem({ client, basePath: `agents/${agentName}` });
      // Filter out /agents subfolder from root — it contains per-session runtime
      // instances (cli:koi-demo:{timestamp}) that are internal state, not user data.
      const filteredFs: import("@koi/core").FileSystemBackend = {
        ...nexusFs,
        list: async (path, options) => {
          const result = await nexusFs.list(path, options);
          if (!result.ok) return result;
          // Filter internal paths from VFS listing
          const hidden = new Set(["/agents", "/session/records"]);
          const filtered = result.value.entries.filter((e) => !hidden.has(e.path));
          if (filtered.length === result.value.entries.length) return result;
          return { ok: true, value: { ...result.value, entries: filtered } };
        },
      };
      return { fs: filteredFs, backend: "nexus" };
    } catch {
      // Fall back to local if Nexus filesystem package is unavailable
    }
  }
  return { fs: createLocalFileSystem(workspaceRoot), backend: "local" };
}

/** Persist chat to Nexus (best-effort, non-fatal). */
async function persistChatToNexus(
  client: {
    readonly rpc: <_T>(m: string, p: Record<string, unknown>) => Promise<{ readonly ok: boolean }>;
  },
  agentName: string,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const path = `/agents/${agentName}/session/chat/${sessionId}.jsonl`;
  // Read existing content, append new entries
  const readResult = (await client.rpc<unknown>("read", { path })) as {
    readonly ok: boolean;
    readonly value?: unknown;
  };
  let existing = "";
  if (readResult.ok && readResult.value !== undefined) {
    const raw = readResult.value;
    // Nexus returns { __type__: "bytes", data: "base64..." }
    if (typeof raw === "string") {
      existing = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (obj.__type__ === "bytes" && typeof obj.data === "string") {
        existing = Buffer.from(obj.data, "base64").toString("utf-8");
      }
    }
  }
  const entries = [
    JSON.stringify({ kind: "user", text: userText, timestamp: Date.now() }),
    JSON.stringify({ kind: "assistant", text: assistantText, timestamp: Date.now() }),
  ].join("\n");
  const content = existing.length > 0 ? `${existing}\n${entries}\n` : `${entries}\n`;
  const writeResult = await client.rpc<null>("write", { path, content });
  if (!writeResult.ok) {
    const err = (writeResult as { readonly error?: { readonly message?: string } }).error;
    throw new Error(`Nexus write failed: ${err?.message ?? "unknown"}`);
  }
}

/** Test Nexus write connectivity — returns true if a test write succeeds. */
async function testNexusWrite(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${baseUrl}/api/nfs/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ path: "/.koi-health-check", content: new Date().toISOString() }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    // Nexus returns HTTP 200 even on JSON-RPC errors — check the body
    const body = await resp.text();
    return !body.includes('"error"');
  } catch {
    return false;
  }
}

/** Probe nexus.yaml for an already-running Nexus instance. Returns URL+key if healthy. */
async function probeExistingNexus(
  workspaceRoot: string,
): Promise<{ readonly baseUrl: string; readonly apiKey: string } | undefined> {
  try {
    const { join } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(workspaceRoot, "nexus.yaml"), "utf-8");

    // Parse YAML manually (just need ports.http and api_key)
    const httpPortMatch = /^\s*http:\s*(\d+)/m.exec(raw);
    const apiKeyMatch = /^api_key:\s*(.+)/m.exec(raw);
    if (httpPortMatch === null || apiKeyMatch === null) return undefined;

    const port = httpPortMatch[1];
    const apiKey = apiKeyMatch[1]?.trim() ?? "";
    const baseUrl = `http://127.0.0.1:${port}`;

    // Health check — timeout 2s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${baseUrl}/api/v2/search/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const body = (await resp.json()) as Record<string, unknown>;
      if (body.status === "healthy") {
        return { baseUrl, apiKey };
      }
    }
  } catch {
    // nexus.yaml missing, unreadable, or Nexus not responding — start fresh
  }
  return undefined;
}

/** Infer actual store backend from config + Nexus availability. */
function inferBackend(
  configured: "nexus" | "sqlite" | "memory" | undefined,
  nexusBaseUrl: string | undefined,
): "nexus" | "sqlite" | "memory" {
  if (configured === "nexus" && nexusBaseUrl !== undefined) return "nexus";
  if (configured === "nexus") return "sqlite"; // Nexus requested but unavailable → fallback
  return configured ?? "memory";
}

/** Kill any stale process holding a port so the current `up` can bind. */
async function freePort(port: number): Promise<void> {
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("lsof", ["-i", `:${String(port)}`, "-t"], { encoding: "utf-8" });
    const pids = (result.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      if (pid !== String(process.pid)) {
        process.kill(Number(pid), "SIGTERM");
      }
    }
    // Brief wait for port release
    if (pids.length > 0) await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Non-fatal — Bun.serve will fail with a clear error if port is still busy
  }
}

export async function runUp(flags: UpFlags): Promise<void> {
  // 0. DETACH — check before crash recovery so background/CI launches
  // don't consume sentinel files meant for the user's interactive terminal.
  if (flags.detach) {
    const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
    await runDetach(manifestPath);
  }

  // Recover terminal from a previous crash (SIGKILL leaves raw mode active).
  // Only attempt on interactive terminals — non-TTY sessions (CI, --detach
  // child) must not consume sentinels they can't actually restore.
  if (process.stdin.isTTY) {
    restoreCrashedTerminal();
  }

  // Validate --nexus-build / --nexus-source and run uv sync if needed
  runNexusBuildIfNeeded(flags.nexusBuild, flags.nexusSource);

  const output = createCliOutput({ verbose: flags.verbose, logFormat: flags.logFormat });
  const timer = createTimer(flags.timing);

  // 1. RESOLVE
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const workspaceRoot = resolve(dirname(manifestPath));

  // 2. VALIDATE
  output.spinner.start("Loading manifest...");
  const loadResult = await timer.time("manifest", () => loadManifest(manifestPath));
  if (!loadResult.ok) {
    output.spinner.stop();

    // Missing manifest + interactive TTY: fall back to welcome mode TUI
    if (loadResult.error.code === "NOT_FOUND" && process.stdin.isTTY === true) {
      output.info("No koi.yaml found — launching welcome screen");
      const { runTui } = await import("../tui.js");
      await runTui({
        command: "tui",
        directory: flags.directory,
        url: undefined,
        authToken: undefined,
        refresh: 5,
        agent: undefined,
        session: undefined,
        mode: "welcome",
        nexusSource: flags.nexusSource,
        nexusBuild: flags.nexusBuild,
        nexusPort: flags.nexusPort,
      });
      return;
    }

    output.error(
      `Failed to load manifest: ${loadResult.error.message}`,
      "run `koi doctor --repair` to auto-fix common issues",
    );
    process.exit(EXIT_CONFIG);
  }
  const { manifest, warnings } = loadResult.value;
  for (const warning of warnings) output.warn(warning.message);
  output.spinner.stop(undefined);
  output.success("Manifest loaded");

  const engineName = getEngineName(manifest);
  const modelName = manifest.model.name;

  // 3. PRESET
  const presetId = await timer.time("preset", () => inferPresetId(manifestPath));
  const manifestStacks = await extractStacks(manifestPath);
  const stackOverrides = Object.keys(manifestStacks).length > 0 ? { stacks: manifestStacks } : {};
  const { resolved: preset } = resolveRuntimePreset(presetId, stackOverrides);
  const services = preset.services;

  // 4. PREFLIGHT
  // Spinner is stopped before preflight because printPreflightIssues()
  // writes directly to process.stderr and would garble active spinner output.
  const temporalAutoStart = services.temporal === "auto" && flags.temporalUrl === undefined;
  const preflight = await timer.time("preflight", async () =>
    runPreflight({
      manifest,
      env: process.env,
      temporalRequired: temporalAutoStart,
      output,
    }),
  );
  if (!preflight.passed) process.exit(EXIT_CONFIG);
  output.success("Preflight passed");

  output.debug(
    `Preset: ${presetId} (tui=${String(services.tui)}, temporal=${services.temporal}, gateway=${String(services.gateway)})`,
  );

  // 5. NEXUS + SUBSYSTEMS (before forge, so search backends are available)
  // Detect orphaned Nexus stacks and block if memory is constrained (#1076)
  if (preset.nexusMode === "embed-auth") {
    try {
      const { readRuntimeState } = await import("@koi/nexus-embed");
      const currentState = readRuntimeState(workspaceRoot);
      const canProceed = detectOrphanedNexusStacks(currentState?.project_name);
      if (!canProceed) {
        process.exit(EXIT_CONFIG);
      }
    } catch {
      // Non-fatal — skip orphan detection if nexus-embed is unavailable
    }
  }

  // Nexus: try reusing existing instance from nexus.yaml before starting a new one
  let nexusBaseUrl = flags.nexusUrl ?? manifest.nexus?.url ?? process.env.NEXUS_URL;
  let nexusStartedByUs = false;
  if (nexusBaseUrl === undefined && preset.nexusMode === "embed-auth") {
    // Probe nexus.yaml for a running instance
    const existing = await probeExistingNexus(workspaceRoot);
    if (existing !== undefined) {
      nexusBaseUrl = existing.baseUrl;
      if (process.env.NEXUS_API_KEY === undefined) {
        process.env.NEXUS_API_KEY = existing.apiKey;
      }
      output.info(`Nexus: reusing existing instance at ${existing.baseUrl}`);
    } else {
      output.spinner.start("Starting Nexus...");
      const nexusResult = await timer.time("nexus-up", () =>
        startNexusStack(workspaceRoot, presetId, flags.verbose, {
          build: flags.nexusBuild || undefined,
          sourceDir: flags.nexusSource,
          port: flags.nexusPort,
          portStrategy: "auto",
        }),
      );
      if (nexusResult !== undefined) {
        nexusBaseUrl = nexusResult.baseUrl;
        nexusStartedByUs = true;
        if (nexusResult.apiKey !== undefined && process.env.NEXUS_API_KEY === undefined) {
          process.env.NEXUS_API_KEY = nexusResult.apiKey;
        }
      }
      output.spinner.stop(undefined);
    }
  }

  // Verify Nexus connectivity with a write test — auto-restart if unhealthy
  if (nexusBaseUrl !== undefined) {
    let nexusWriteOk = await testNexusWrite(nexusBaseUrl, process.env.NEXUS_API_KEY ?? "");
    if (!nexusWriteOk) {
      // Raft may need time to re-elect leader after container resume — retry for up to 30s
      output.spinner.start("Waiting for Nexus Raft leader...");
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        nexusWriteOk = await testNexusWrite(nexusBaseUrl, process.env.NEXUS_API_KEY ?? "");
        if (nexusWriteOk) break;
      }
      output.spinner.stop(undefined);
      if (nexusWriteOk) {
        output.success("Nexus ready");
      } else {
        output.warn("Nexus write check failed — storage may not work. Try: nexus down && nexus up");
      }
    }
  }

  // Temporal auto-start
  let temporalEmbedHandle: Awaited<ReturnType<typeof startTemporalEmbed>>;
  let temporalUrl = flags.temporalUrl;
  if (temporalAutoStart) {
    output.spinner.start("Starting Temporal...");
    temporalEmbedHandle = await timer.time("temporal-embed", () =>
      startTemporalEmbed(flags.verbose),
    );
    if (temporalEmbedHandle !== undefined) temporalUrl = temporalEmbedHandle.url;
    output.spinner.stop(undefined);
  }

  const embedProfile = nexusStartedByUs ? undefined : mapNexusModeToProfile(preset.nexusMode);

  // Resolve subsystems — Nexus first (autonomous needs its connection), then autonomous + temporal in parallel
  output.spinner.start("Resolving subsystems...");
  const [nexusResolution, [autonomousResolution, temporalAdmin]] = await timer.time(
    "subsystems",
    async () => {
      const nRes = await resolveNexusOrWarn(
        nexusBaseUrl,
        manifest.nexus?.url,
        flags.verbose,
        embedProfile,
        flags.nexusSource,
      );
      const rest = await Promise.all([
        resolveAutonomousOrWarn(manifest, flags.verbose, nRes.state.connection),
        temporalUrl !== undefined
          ? resolveTemporalOrWarn(temporalUrl, flags.verbose)
          : Promise.resolve(undefined),
      ]);
      return [nRes, rest] as const;
    },
  );
  const nexus = nexusResolution.state;
  const autonomous = autonomousResolution.result;

  // Ensure NEXUS_API_KEY is set for ALL presets (not just embed-auth).
  // resolveNexusOrWarn → createNexusStack → ensureNexusRunning may have
  // set it in env (via our nexus-stack.ts fix), but if not, probe for it.
  if (process.env.NEXUS_API_KEY === undefined && nexus.baseUrl !== undefined) {
    const probed = await probeExistingNexus(workspaceRoot);
    if (probed?.apiKey !== undefined) {
      process.env.NEXUS_API_KEY = probed.apiKey;
    }
  }

  // Temporal contribution (inline — temporal resolution doesn't have its own bootstrap fn)
  const temporalContribution: StackContribution =
    temporalAdmin !== undefined
      ? {
          id: "temporal",
          label: "Temporal",
          enabled: true,
          source: "runtime",
          status: "active",
          packages: [
            {
              id: "@koi/temporal",
              kind: "subsystem",
              source: "static",
              notes: [`url: ${temporalUrl ?? "unknown"}`],
            },
          ],
        }
      : {
          id: "temporal",
          label: "Temporal",
          enabled: false,
          source: "runtime",
          status: "skipped",
          reason: "temporal not configured",
          packages: [],
        };

  output.spinner.stop(undefined);
  output.success("Subsystems resolved");

  // 5b. FORGE + AUTO-HARNESS
  // Auto-harness needs forgeStore at construction, so we pre-create the store
  // and pass harness outputs into forge bootstrap for full synthesis wiring.
  let sessionCounter = 0;
  // --resume: start from the given session ID so context-arena loads its history
  if (flags.resume !== undefined) {
    // Parse counter from "up:name:N" format if possible
    const parts = flags.resume.split(":");
    const parsed = Number.parseInt(parts[parts.length - 1] ?? "", 10);
    if (!Number.isNaN(parsed)) sessionCounter = parsed;
  }
  let currentSessionId = flags.resume ?? `up:${manifest.name}:${String(sessionCounter)}`;

  // Track which storage backends are actually active (for banner)
  const activeStorage = {
    threads: "memory",
    ace: "memory",
    forge: "memory",
    vfs: "local",
  } as Record<string, string>;

  // Pre-create auto-harness when preset enables it and forge is enabled.
  // The same store is shared with forge bootstrap so synthesized bricks
  // land in the active forge system.
  let autoHarnessOutputs: import("../../bootstrap-forge.js").AutoHarnessOutputs | undefined;
  let preCreatedHarnessMiddleware: import("@koi/core").KoiMiddleware | undefined;
  if (preset.stacks.autoHarness === true && manifest.forge !== undefined) {
    try {
      const { createInMemoryForgeStore } = await import("@koi/forge");
      const { createAutoHarnessStack } = await import("@koi/auto-harness");
      // Use Nexus-backed forge store when available, fall back to in-memory
      let preForgeStore: import("@koi/core").ForgeStore;
      if (nexus.baseUrl !== undefined) {
        try {
          const { createNexusForgeStore } = await import("@koi/nexus-store");
          const nexusKey = process.env.NEXUS_API_KEY ?? "";
          if (nexusKey === "") {
            process.stderr.write("warn: NEXUS_API_KEY not set — forge store will fail auth\n");
          }
          preForgeStore = createNexusForgeStore({
            baseUrl: nexus.baseUrl,
            apiKey: nexusKey,
            basePath: `agents/${manifest.name}/bricks`,
          });
          activeStorage.forge = "nexus";
        } catch {
          preForgeStore = createInMemoryForgeStore();
        }
      } else {
        preForgeStore = createInMemoryForgeStore();
      }
      const harnessStack = createAutoHarnessStack({
        forgeStore: preForgeStore,
        generate: async () => "",
      });
      preCreatedHarnessMiddleware = harnessStack.policyCacheMiddleware;
      autoHarnessOutputs = {
        store: preForgeStore,
        synthesizeHarness: harnessStack.synthesizeHarness,
        maxSynthesesPerSession: harnessStack.maxSynthesesPerSession,
        policyCacheHandle: harnessStack.policyCacheHandle,
      };
    } catch {
      // Auto-harness is non-fatal
    }
  }

  const forgeResolution = await timer.time("forge", () =>
    bootstrapForgeOrWarn(
      manifest,
      () => currentSessionId,
      flags.verbose,
      autoHarnessOutputs,
      nexus.search,
    ),
  );
  const forgeBootstrap = forgeResolution.result?.bootstrap;
  const sandboxBridge = forgeResolution.result?.sandboxBridge;

  const { createAgentChatBridge } = await import("../../agui-chat-bridge.js");
  const chatBridge: AgentChatBridge = createAgentChatBridge({ mode: "stateful" });

  // 6. RESOLVE agent + subsystems
  output.spinner.start("Resolving agent...");
  const resolved = await timer.time("resolve", () =>
    resolveAgent({
      manifestPath,
      manifest,
      ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
    }),
  );
  if (!resolved.ok) {
    output.spinner.stop();
    output.error(formatResolutionError(resolved.error));
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    if (autonomous !== undefined) await autonomous.dispose();
    if (temporalAdmin !== undefined) await temporalAdmin.dispose();
    if (nexus.dispose !== undefined) await nexus.dispose();
    // Nexus containers persist — don't stop on error exit either.
    if (temporalEmbedHandle !== undefined) await temporalEmbedHandle.dispose();
    process.exit(EXIT_CONFIG);
  }
  output.spinner.stop(undefined);
  output.success("Agent resolved");

  const adapter = resolved.value.engine ?? createPiAdapter({ model: modelName });

  // 7. ASSEMBLE
  output.spinner.start("Assembling runtime...");
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  // Data source auto-discovery (non-fatal)
  let dataSourceProvider: import("@koi/core").ComponentProvider | undefined;
  let dataSourceTools: readonly import("@koi/core").Tool[] = [];
  let discoveredSourceNames: readonly { readonly name: string; readonly protocol: string }[] = [];
  let discoveredSourceSummaries:
    | readonly import("@koi/dashboard-types").DataSourceSummary[]
    | undefined;
  let discoveredDescriptors: readonly import("@koi/core").DataSourceDescriptor[] | undefined;
  let dataSourceExecutorFn:
    | ((
        source: import("@koi/core").DataSourceDescriptor,
        query: unknown,
        credential: string | undefined,
      ) => Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: string }>)
    | undefined;
  let probeEnvFn:
    | ((
        env: Readonly<Record<string, string | undefined>>,
        patterns: readonly string[],
      ) => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[])
    | undefined;
  try {
    const { createDataSourceStack } = await import("@koi/data-source-stack");
    const manifestEntries = (manifest as unknown as Record<string, unknown>).dataSources as
      | readonly import("@koi/data-source-stack").ManifestDataSourceEntry[]
      | undefined;
    const dsStack = await createDataSourceStack({
      manifestEntries,
      env: process.env,
      consent: createInteractiveConsent(output),
    });
    if (dsStack.discoveredSources.length === 0) {
      output.info("No data sources found — add MCP servers to koi.yaml or set credentials in .env");
    } else {
      dataSourceProvider = dsStack.provider;
      dataSourceTools = dsStack.tools;
      discoveredSourceNames = dsStack.discoveredSources.map((s) => ({
        name: s.name,
        protocol: s.protocol,
      }));
      // Build summaries for the dashboard bridge
      const manifestNames = new Set((manifestEntries ?? []).map((e) => e.name));
      discoveredSourceSummaries = dsStack.discoveredSources.map((s) => ({
        name: s.name,
        protocol: s.protocol,
        status: "approved" as const,
        source: manifestNames.has(s.name)
          ? ("manifest" as const)
          : s.mcpToolName !== undefined
            ? ("mcp" as const)
            : ("env" as const),
      }));
      discoveredDescriptors = dsStack.discoveredSources;

      // Print credential fallback guidance for sources needing auth
      for (const source of dsStack.discoveredSources) {
        if (source.auth?.ref !== undefined && process.env[source.auth.ref] === undefined) {
          output.warn(
            `Source "${source.name}" needs credential — set ${source.auth.ref} in your environment`,
          );
        }
      }
    }
    // Capture executor for schema probing in dashboard bridge
    const { executeDataSourceQuery } = await import("@koi/data-source-stack");
    dataSourceExecutorFn = executeDataSourceQuery;
    // Capture probeEnv for rescan callback (avoids L2→L2 import in bridge)
    const { probeEnv } = await import("@koi/data-source-discovery");
    probeEnvFn = probeEnv;
  } catch {
    // Data source discovery is non-fatal
  }

  // Wire context-arena conversation persistence (Decision 1A, 2A)
  // let justified: mutable message buffer so context-arena squash middleware can
  // partition tool results; updated per-message in the channel onMessage handler.
  let currentUpMessages: readonly InboundMessage[] = [];
  // let justified: mutable thread key read by conversation middleware's resolveThreadId
  // When resuming, pre-set the thread key so conversation middleware loads history
  let currentUpThreadKey: string | undefined = flags.resume;

  let contextArenaDispose: (() => void | Promise<void>) | undefined;
  let contextArenaConfig: import("@koi/context-arena").ContextArenaConfig | undefined;

  if (preset.stacks.contextArena === true) {
    try {
      // For nexus backend, create a dedicated thread snapshot store
      let nexusSnapshotStore: import("@koi/core").ThreadSnapshotStore | undefined;
      if (nexus.baseUrl !== undefined) {
        try {
          const { createNexusSnapshotStore } = await import("@koi/nexus-store");
          nexusSnapshotStore = createNexusSnapshotStore({
            baseUrl: nexus.baseUrl,
            apiKey: process.env.NEXUS_API_KEY ?? "",
            basePath: `agents/${manifest.name}/threads`,
          });
          activeStorage.threads = "nexus";
        } catch {
          activeStorage.threads = "sqlite";
        }
      }

      const arenaResult = createContextArenaConfigForUp({
        summarizer: resolved.value.model,
        manifestName: manifest.name,
        threadStoreBackend:
          nexus.baseUrl !== undefined ? "nexus" : (preset.stacks.threadStoreBackend ?? "memory"),
        dataDir: resolve(workspaceRoot, ".koi", "data"),
        ...(nexusSnapshotStore !== undefined ? { nexusSnapshotStore } : {}),
        getMessages: () => currentUpMessages,
        resolveThreadId: () => currentUpThreadKey,
      });
      contextArenaConfig = arenaResult.config;
      contextArenaDispose = arenaResult.dispose;

      if (flags.verbose) {
        process.stderr.write(
          `  Context-arena: wired (backend=${preset.stacks.threadStoreBackend ?? "memory"})\n`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (flags.verbose) {
        process.stderr.write(`  Context-arena: disabled (${message})\n`);
      }
    }
  }

  // Validate resumed session exists (best-effort via JSONL file check)
  if (flags.resume !== undefined) {
    const { existsSync } = await import("node:fs");
    const chatFile = resolve(
      workspaceRoot,
      "agents",
      manifest.name,
      "session",
      "chat",
      `${flags.resume}.jsonl`,
    );
    if (!existsSync(chatFile)) {
      output.warn(`Session "${flags.resume}" not found — starting fresh conversation`);
    }
  }

  // Activate L3 stacks based on preset flags
  // Upgrade store backends to Nexus when Nexus is available,
  // but respect explicit user overrides from manifest stacks config
  const effectiveStacks = {
    ...preset.stacks,
    ...(nexus.baseUrl !== undefined
      ? {
          threadStoreBackend: preset.stacks.threadStoreBackend ?? ("nexus" as const),
          aceStoreBackend: preset.stacks.aceStoreBackend ?? ("nexus" as const),
        }
      : {}),
    // Auto-enable sandboxStack when the manifest declares a sandbox config
    ...(manifest.codeSandbox !== undefined ? { sandboxStack: true as const } : {}),
  };
  const activatedStacks = await activatePresetStacks({
    stacks: effectiveStacks,
    forgeBootstrap:
      forgeBootstrap !== undefined
        ? { store: forgeBootstrap.store, runtime: forgeBootstrap.runtime }
        : undefined,
    verbose: flags.verbose,
    ...(preCreatedHarnessMiddleware !== undefined
      ? { preCreatedAutoHarness: { policyCacheMiddleware: preCreatedHarnessMiddleware } }
      : {}),
    ...(contextArenaConfig !== undefined ? { contextArenaConfig } : {}),
    aceDataDir: resolve(workspaceRoot, ".koi", "data"),
    ...((nexusBaseUrl ?? nexus.baseUrl) !== undefined
      ? { nexusBaseUrl: (nexusBaseUrl ?? nexus.baseUrl) as string }
      : {}),
    ...(process.env.NEXUS_API_KEY !== undefined ? { nexusApiKey: process.env.NEXUS_API_KEY } : {}),
    agentName: manifest.name,
    ...(manifest.codeSandbox !== undefined ? { sandboxConfig: manifest.codeSandbox } : {}),
    ...(effectiveStacks.ace === true
      ? await (async () => {
          const mc = await createAceModelCall();
          return mc !== undefined ? { aceModelCall: mc } : {};
        })()
      : {}),
  });

  // Resolve manifest tools (tools.koi section) into ComponentProviders
  const manifestToolProviders = await resolveManifestTools(manifest, flags.verbose);

  // Aggregate bootstrap contributions from all subsystems
  const bootstrapContributions: readonly StackContribution[] = [
    nexusResolution.contribution,
    forgeResolution.contribution,
    autonomousResolution.contribution,
    temporalContribution,
  ];

  // Cost tracking — reads from engine metrics on each turn
  const SESSION_BUDGET = 2.0;
  const costCalculator = createDefaultCostCalculator();
  // let justified: accumulated real cost from engine metrics, updated on each turn completion
  let totalCostUsd = 0;

  const composed = composeRuntimeMiddleware({
    resolved: resolved.value.middleware,
    nexus,
    forge: forgeBootstrap,
    autonomous,
    chatBridge,
    dataSourceProvider,
    dataSourceTools,
    presetMiddleware: activatedStacks.middleware,
    presetProviders: [...activatedStacks.providers, ...manifestToolProviders],
    presetContributions: [...activatedStacks.contributions, ...bootstrapContributions],
  });

  // Late-binding event sink for forge/monitor SSE events
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  const { runtime } = await timer.time("runtime", () =>
    createForgeConfiguredKoi({
      manifest,
      adapter,
      middleware: composed.middleware,
      providers: composed.providers,
      extensions,
      ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
      debug: { enabled: true },
      onDashboardEvent: (event: DashboardEvent) => {
        emitDashboardEvent?.(event);
      },
    }),
  );
  output.spinner.stop(undefined);
  output.success("Runtime assembled");

  // Bind autonomous session lifecycle — the runtime is only available after assembly.
  if (autonomous !== undefined) {
    // Bind push notifications via copilot's MAILBOX (if attached).
    const { MAILBOX: MAILBOX_TOKEN } = await import("@koi/core");
    const copilotMailbox = runtime.agent.component(MAILBOX_TOKEN) as
      | import("@koi/core").MailboxComponent
      | undefined;
    if (copilotMailbox !== undefined) {
      autonomous.bindNotification(runtime.agent.pid.id, copilotMailbox);
    }

    // Bind spawn function for delegation bridge dispatch.
    // Uses spawnChildAgent to create independent child agent runtimes.
    const { createCliSpawnFn } = await import("../../create-cli-spawn-fn.js");
    const spawnFn = await createCliSpawnFn({ runtime, adapter });
    autonomous.bindSpawn(spawnFn);

    // Bind session runner — scheduler calls this after resume() to run engine sub-sessions.
    autonomous.bindSessionRunner(async (resumeResult: unknown) => {
      const { engineInput, sessionId } = resumeResult as {
        engineInput: import("@koi/core").EngineInput;
        sessionId: string;
      };
      process.stderr.write(`[autonomous] running sub-session ${sessionId}...\n`);

      let lastMetrics: import("@koi/core").EngineMetrics | undefined;
      for await (const event of runtime.run(engineInput)) {
        if (event.kind === "done") {
          lastMetrics = event.output.metrics;
          if (event.output.stopReason === "error") {
            const errMeta = event.output.metadata as Record<string, unknown> | undefined;
            const errMsg =
              errMeta !== undefined && typeof errMeta.errorMessage === "string"
                ? errMeta.errorMessage
                : "unknown error";
            process.stderr.write(`[autonomous] sub-session error: ${errMsg}\n`);
          }
        }
      }

      // Pause harness → suspended so scheduler can resume for next session
      if (lastMetrics !== undefined) {
        process.stderr.write(
          `[autonomous] sub-session done (${String(lastMetrics.turns)} turns) — pausing harness\n`,
        );
        await autonomous.pauseHarness({ sessionId, metrics: lastMetrics });
      }
    });
  }

  // 8. Prepare channels (connected after TUI decision in step 12b)
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];

  // 8b. Gateway + Node (conditional on preset services)
  const DEFAULT_GATEWAY_PORT = 4100;
  let stopGateway: (() => Promise<void>) | undefined;
  let stopNode: (() => Promise<void>) | undefined;

  if (services.gateway) {
    try {
      const { createGatewayStack } = await import("@koi/gateway-stack");
      const { createBunTransport } = await import("@koi/gateway");
      const transport = createBunTransport();
      const auth = {
        authenticate: async () => ({
          ok: true as const,
          sessionId: "local",
          agentId: manifest.name,
          metadata: {} as Readonly<Record<string, unknown>>,
        }),
        validate: async () => true,
      };
      const nexusConfig =
        nexusBaseUrl !== undefined
          ? { nexusUrl: nexusBaseUrl, apiKey: process.env.NEXUS_API_KEY ?? "" }
          : undefined;
      const gwStack = createGatewayStack(
        { ...(nexusConfig !== undefined ? { nexus: nexusConfig } : {}) },
        { transport, auth },
      );
      await gwStack.start(DEFAULT_GATEWAY_PORT);
      stopGateway = () => gwStack.stop();
      output.success(`Gateway started on port ${String(DEFAULT_GATEWAY_PORT)}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`gateway failed to start: ${message}`);
    }
  }

  if (services.node !== "disabled") {
    try {
      const { createNodeStack } = await import("@koi/node-stack");
      // Map preset node mode ("full" | "thin") and connect to local gateway
      const gatewayWsUrl = `ws://127.0.0.1:${String(DEFAULT_GATEWAY_PORT)}`;
      const nodeMode = services.node === "thin" ? "thin" : "full";
      const nodeStack = createNodeStack(
        {
          node: {
            mode: nodeMode,
            gateway: { url: gatewayWsUrl },
          },
        },
        {},
      );
      await nodeStack.start();
      stopNode = () => nodeStack.stop();
      output.success(`Node started (mode=${nodeMode})`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`node failed to start: ${message}`);
    }
  }

  // 8b. Demo pack seed (before admin so seeded bricks are available for forge view)
  const demoPack = (await extractDemoPack(manifestPath)) ?? preset.demoPack;
  let nexusClient: import("@koi/nexus-client").NexusClient | undefined;
  if (nexus.baseUrl !== undefined) {
    const { createNexusClient } = await import("@koi/nexus-client");
    const apiKey = process.env.NEXUS_API_KEY;
    nexusClient = createNexusClient({
      baseUrl: nexus.baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }
  if (demoPack !== undefined) {
    output.spinner.start("Seeding demo data");
  }
  const seedResult = await seedDemoPackIfNeeded(
    demoPack,
    workspaceRoot,
    manifest.name,
    nexusClient,
    flags.verbose,
  );
  if (demoPack !== undefined) {
    output.spinner.stop(undefined);
    if (seedResult.prompts.length > 0) {
      output.success("Demo data seeded");
    }
  }

  // 9. ADMIN — kill stale processes on required ports before binding
  const DEFAULT_ADMIN_PORT = 3100;
  // Do NOT call freePort() — it kills other koi up instances running on this port.
  // The retry loop below (lines 1384-1410) gracefully increments to the next free port.
  let stopAdmin: (() => void) | undefined;
  let adminBridge: AdminPanelBridgeResult | undefined;
  let adminDispatcher: ReturnType<typeof createAgentDispatcher> | undefined;
  let adminReady = false;
  // let justified: mutable port, may be incremented if DEFAULT_ADMIN_PORT is busy
  let boundPort = DEFAULT_ADMIN_PORT;

  try {
    const channelNames = channels.map((ch) => ch.name);
    const skillNames = (manifest.skills ?? []).map((s) => s.name);
    const orch = resolveOrchestrationFromAgent({
      agent: runtime.agent,
      temporal: temporalAdmin,
      ...(autonomous !== undefined ? { harness: autonomous.harness } : {}),
      verbose: flags.verbose,
    });

    const subsystem = collectSubsystemMiddleware({
      nexus,
      forge: forgeBootstrap,
      autonomous,
    });

    // Build per-role manifest overrides for demo agents
    const demoOverrides = await buildDemoManifestOverrides(manifest.name, demoPack);

    const dispatcher = createAgentDispatcher({
      defaultManifestPath: manifestPath,
      verbose: flags.verbose,
      additionalMiddleware: subsystem.middleware,
      additionalProviders: subsystem.providers,
      additionalExtensions: extensions,
      ...(forgeBootstrap !== undefined
        ? { forgeStore: forgeBootstrap.store, forgeRuntime: forgeBootstrap.runtime }
        : {}),
      ...(demoOverrides !== undefined ? { manifestOverrides: demoOverrides } : {}),
      onDashboardEvent: (event) => {
        emitDashboardEvent?.(event as DashboardEvent);
      },
    });
    adminDispatcher = dispatcher;

    const debugApi = runtime.debug;
    adminBridge = createAdminPanelBridge({
      agentName: manifest.name,
      agentType: manifest.lifecycle ?? "copilot",
      model: modelName,
      channels: channelNames,
      skills: skillNames,
      cost: {
        async getSnapshot(): Promise<CostSnapshot> {
          const totalCost = totalCostUsd;
          const agents: readonly AgentCostEntry[] = [
            {
              agentId: "" as import("@koi/core").AgentId,
              name: manifest.name,
              model: modelName,
              turns: 0,
              costUsd: totalCost,
              budgetUsed: totalCost,
              budgetLimit: SESSION_BUDGET,
            },
          ];
          return {
            sessionBudget: { used: totalCost, limit: SESSION_BUDGET },
            dailyBudget: { used: totalCost, limit: 10.0 },
            monthlyBudget: { used: totalCost, limit: 50.0 },
            agents,
            cascade: { tiers: [], savingsUsd: 0, baselineModel: "sonnet" },
            circuitBreaker: { state: "CLOSED", failures: 0, threshold: 5, windowMs: 60_000 },
            timestamp: Date.now(),
          };
        },
      },
      fileSystem: await (async () => {
        const vfs = await createVfsBackend(workspaceRoot, nexus.baseUrl, manifest.name);
        activeStorage.vfs = vfs.backend;
        return vfs.fs;
      })(),
      discoveredSources: discoveredSourceSummaries,
      dataSourceDescriptors: discoveredDescriptors,
      ...(dataSourceExecutorFn !== undefined ? { dataSourceExecutor: dataSourceExecutorFn } : {}),
      ...(probeEnvFn !== undefined
        ? {
            probeEnvForSources: createProbeCallback(probeEnvFn),
          }
        : {}),
      dispatchAgent: dispatcher.dispatchAgent,
      onTerminateAgent: async (id) => {
        await dispatcher.terminateAgent(id);
      },
      ...(orch.hasAny
        ? { orchestration: orch.orchestration, orchestrationCommands: orch.orchestrationCommands }
        : {}),
      ...(activatedStacks.governanceCommands !== undefined
        ? { governanceCommands: activatedStacks.governanceCommands }
        : {}),
      ...(forgeBootstrap !== undefined
        ? {
            forge: createForgeViewSource(
              forgeBootstrap.store,
              seedResult.seededBricks,
              seedResult.seededForgeEvents,
            ),
          }
        : seedResult.seededBricks.length > 0
          ? {
              forge: createSeededOnlyForgeViewSource(
                seedResult.seededBricks,
                seedResult.seededForgeEvents,
              ),
            }
          : {}),
      ...(forgeBootstrap !== undefined
        ? {
            forgeCommands: {
              async promoteBrick(id: string) {
                const r = await forgeBootstrap.store.update(brickId(id), { lifecycle: "active" });
                return r.ok ? ({ ok: true, value: undefined } as const) : r;
              },
              async demoteBrick(id: string) {
                const r = await forgeBootstrap.store.update(brickId(id), {
                  policy: {
                    sandbox: true,
                    capabilities: {
                      network: { allow: false },
                      filesystem: {
                        read: ["/usr", "/bin", "/lib", "/etc", "/tmp"],
                        write: ["/tmp/koi-sandbox-*"],
                      },
                      resources: {
                        maxMemoryMb: 512,
                        timeoutMs: 30000,
                        maxPids: 64,
                        maxOpenFiles: 256,
                      },
                    },
                  },
                });
                return r.ok ? ({ ok: true, value: undefined } as const) : r;
              },
              async quarantineBrick(id: string) {
                const r = await forgeBootstrap.store.update(brickId(id), { lifecycle: "failed" });
                return r.ok ? ({ ok: true, value: undefined } as const) : r;
              },
            },
          }
        : {}),
      ...(debugApi !== undefined
        ? {
            debug: {
              getInventory: (_agentId) =>
                debugApi.getInventory(
                  buildDebugExtraItems({
                    channels: channelNames,
                    skills: skillNames,
                    model: modelName,
                    engineAdapter: adapter.engineId,
                    tools: manifest.tools,
                    subsystems: collectActiveSubsystems({
                      nexusEnabled: nexusBaseUrl !== undefined,
                      forgeEnabled: forgeBootstrap !== undefined,
                      contextArenaEnabled: contextArenaConfig !== undefined,
                      autonomousEnabled: autonomous !== undefined,
                      gatewayEnabled: stopGateway !== undefined,
                      schedulerEnabled: autonomous?.harness !== undefined,
                      harnessEnabled: autonomous?.harness !== undefined,
                      temporalEnabled: temporalAdmin !== undefined,
                      sandboxEnabled: sandboxBridge !== undefined,
                    }),
                  }),
                ),
              getTrace: (_agentId, turnIndex) => debugApi.getTrace(turnIndex),
              getContributions: () =>
                addPostCompositionContributions(
                  composed.contributions,
                  channelNames,
                  adapter.engineId,
                  modelName,
                ),
            },
          }
        : {}),
    });

    // Wire forge/monitor SSE event sink now that the bridge exists
    emitDashboardEvent = adminBridge.emitEvent;

    // Wire task board → SSE push: task status changes appear in TUI in real-time
    if (autonomous !== undefined) {
      autonomous.bindDashboardEvent(adminBridge.emitEvent);
    }

    // Wire governance → SSE push: when a tool call is blocked, emit immediately
    if (activatedStacks.governanceCommands?.setOnEnqueue) {
      activatedStacks.governanceCommands.setOnEnqueue((item) => {
        adminBridge?.emitEvent({
          kind: "governance",
          subKind: "approval_required",
          approvalId: item.id,
          agentId: item.agentId,
          action: item.requestKind,
          resource: JSON.stringify(item.payload).slice(0, 40),
          timestamp: item.timestamp,
        });
      });
    }

    const routingChatHandler = createChatRouter({
      primaryHandler: chatBridge.handler,
      getDispatchedHandler: dispatcher.getChatHandler,
      isPrimaryAgent: (id) => id === adminBridge?.agentId,
    });

    const assetsDir = resolveDashboardAssetsDir();
    const dashboardResult: DashboardHandlerResult = createDashboardHandler(
      { ...adminBridge, agentChatHandler: routingChatHandler },
      { cors: true, ...(assetsDir !== undefined ? { assetsDir } : {}) },
    );

    // Try up to 10 ports starting from DEFAULT_ADMIN_PORT to handle stale processes
    let server: ReturnType<typeof Bun.serve> | undefined;
    boundPort = DEFAULT_ADMIN_PORT;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        server = await timer.time("admin", async () =>
          Bun.serve({
            port: boundPort,
            idleTimeout: 255,
            async fetch(req: Request): Promise<Response> {
              const adminResponse = await dashboardResult.handler(req);
              if (adminResponse !== null) return adminResponse;
              return new Response("Not Found", { status: 404 });
            },
          }),
        );
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        if (
          msg.includes("EADDRINUSE") ||
          msg.includes("address already in use") ||
          msg.includes("port")
        ) {
          boundPort = DEFAULT_ADMIN_PORT + attempt + 1;
          continue;
        }
        throw err;
      }
    }
    if (server === undefined) {
      throw new Error(`Ports ${String(DEFAULT_ADMIN_PORT)}-${String(boundPort)} all in use`);
    }
    if (boundPort !== DEFAULT_ADMIN_PORT) {
      output.info(`Port ${String(DEFAULT_ADMIN_PORT)} busy → using ${String(boundPort)}`);
    }

    stopAdmin = () => {
      server?.stop(true);
      dashboardResult.dispose();
    };
    adminReady = true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.warn(`admin panel failed to start: ${message}`);
    adminBridge = undefined;
  }

  const persistAgentId = adminBridge?.agentId ?? manifest.name;

  // 9b. Demo agent provisioning
  const provisionedAgents = await provisionDemoAgents(
    demoPack,
    manifestPath,
    adminDispatcher,
    flags.verbose,
  );

  // 10. Health server
  const DEFAULT_HEALTH_PORT = 9100;
  await freePort(DEFAULT_HEALTH_PORT);
  let stopHealth: (() => void) | undefined;
  try {
    const { createHealthServer } = await import("@koi/deploy");
    const healthServer = createHealthServer({
      port: manifest.deploy?.port ?? DEFAULT_HEALTH_PORT,
      onReady: () => true,
    });
    const healthInfo = await healthServer.start();
    stopHealth = () => healthServer.stop();
    output.debug(`Health server: ${healthInfo.url}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.warn(`health server failed to start: ${message}`);
  }

  // 11. BANNER
  timer.print();
  printBanner({
    agentName: manifest.name,
    presetId,
    nexusMode: preset.nexusMode,
    engineName,
    modelName,
    channels,
    nexusBaseUrl: nexus.baseUrl,
    adminReady,
    adminPort: boundPort,
    temporalAdmin,
    temporalUrl,
    provisionedAgents,
    discoveredSources: discoveredSourceNames,
    prompts: seedResult.prompts,
    storage: {
      threads:
        nexus.baseUrl !== undefined
          ? "nexus"
          : inferBackend(preset.stacks.threadStoreBackend, nexus.baseUrl),
      ace:
        nexus.baseUrl !== undefined
          ? "nexus"
          : inferBackend(preset.stacks.aceStoreBackend, nexus.baseUrl),
      forge: activeStorage.forge as "nexus" | "memory",
      vfs: activeStorage.vfs as "nexus" | "local",
    },
  });

  if (flags.resume !== undefined) {
    output.info(`Resuming session: ${flags.resume}`);
  }

  // 12. TUI
  let tuiApp:
    | { readonly start: () => Promise<void>; readonly stop: () => Promise<void> }
    | undefined;
  let tuiAttached = false;
  if (adminReady && services.tui) {
    try {
      const { createTuiApp } = await import("@koi/tui");
      tuiApp = createTuiApp({
        adminUrl: `http://localhost:${String(boundPort)}/admin/api`,
        ...(flags.resume !== undefined ? { initialSessionId: currentSessionId } : {}),
      });
      // Save terminal state before entering raw mode so it can be restored
      // on next startup if the process is killed by SIGKILL (uncatchable).
      saveTerminalState();
      await tuiApp.start();
      tuiAttached = true;
    } catch {
      // start() may have entered raw mode before failing — force cleanup.
      try {
        tuiApp?.stop().catch(() => {});
      } catch {
        // Best effort
      }
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // May not be in raw mode
        }
      }
      clearTerminalState();
      tuiApp = undefined;
    }
  }

  // Defense-in-depth: restore terminal on any exit path (same pattern as tui.ts).
  // Catches cases where the normal cleanup sequence hangs or throws.
  // No tuiAttached guard — start() may have entered raw mode before failing.
  const forceRestoreTerminal = (): void => {
    try {
      tuiApp?.stop().catch(() => {});
    } catch {
      // Best effort
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // May not be in raw mode
      }
    }
    clearTerminalState();
  };
  process.on("exit", forceRestoreTerminal);
  process.on("uncaughtException", (err) => {
    forceRestoreTerminal();
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  // 12b. Connect channels — skip CLI when TUI owns stdin/stdout
  if (tuiAttached) {
    const nonCli = channels.filter((ch) => ch.name !== "cli");
    await Promise.all(nonCli.map((ch) => ch.connect()));
    output.info("Operator console attached.\n");
  } else {
    await Promise.all(channels.map((ch) => ch.connect()));
    output.info("Type a message or Ctrl+C to stop.\n");
  }

  // 12c. Scheduler — activate cron schedule from manifest
  let schedulerCron: { stop: () => void } | undefined;
  const scheduleExpr = (manifest as unknown as Record<string, unknown>).schedule as
    | string
    | undefined;
  if (scheduleExpr !== undefined && scheduleExpr.trim() !== "") {
    try {
      const { Cron } = await import("croner");
      const cronJob = new Cron(scheduleExpr, async () => {
        if (tuiProcessing || channelProcessing) return; // skip if agent is busy
        try {
          for await (const event of runtime.run({ kind: "text", text: "scheduled run" })) {
            if (event.kind === "text_delta" && !tuiAttached) {
              process.stderr.write(event.delta);
            }
          }
        } catch {
          // Non-fatal — next cron tick will retry
        }
      });
      schedulerCron = { stop: () => cronJob.stop() };
      output.info(`Scheduler: ${scheduleExpr}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`scheduler failed: ${message}`);
    }
  }

  // 13. REPL + shutdown
  const controller = new AbortController();
  let shuttingDown = false;

  function shutdown(reason?: string): void {
    if (shuttingDown) {
      process.stderr.write("\nForce exit.\n");
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(`\n[shutdown] triggered by: ${reason ?? "unknown"}\n`);
    output.info("Shutting down...");
    controller.abort();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  // SIGHUP is sent by tmux on session rename/detach — ignore it in interactive TUI mode.
  // Only treat it as a shutdown signal when running headless (no TTY).
  if (process.stdin.isTTY !== true) {
    process.on("SIGHUP", () => shutdown("SIGHUP"));
  } else {
    process.on("SIGHUP", () => {});
  }
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[shutdown] uncaughtException: ${err.message}\n${err.stack ?? ""}\n`);
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`[shutdown] unhandledRejection: ${msg}\n`);
  });

  // Separate concurrency guards for TUI (AG-UI bridge) and channel handlers.
  // This allows TUI and channels (Telegram, Slack, etc.) to process messages
  // independently without blocking each other with "agent is busy" errors.
  let tuiProcessing = false;
  let channelProcessing = false;

  chatBridge.wireDispatch(async (msg) => {
    if (tuiProcessing) {
      throw new Error("Agent is busy processing another request");
    }
    tuiProcessing = true;
    try {
      const text = extractTextFromBlocks(msg.content);
      process.stderr.write(`[dispatch] message received: "${text.slice(0, 50)}..."\n`);
      if (text.trim() === "") return;
      const threadId = msg.threadId ?? `chat-${Date.now().toString(36)}`;
      // Expand stateless-normalized blocks ([user]: ..., [assistant]: ...)
      // into separate InboundMessages for proper multi-turn conversation.
      const expanded = expandLabeledBlocks(msg);
      const input: EngineInput = { kind: "messages", messages: expanded };
      const deltas: string[] = [];
      let turnCount = 0;
      for await (const event of runtime.run(input)) {
        if (event.kind === "text_delta") deltas.push(event.delta);
        if (event.kind === "done") {
          process.stderr.write(
            `[dispatch] done: stopReason=${event.output.stopReason} turns=${String(event.output.metrics.turns)}\n`,
          );
          if (event.output.stopReason === "error") {
            const errMeta = event.output.metadata as Record<string, unknown> | undefined;
            const errMsg =
              errMeta !== undefined && typeof errMeta.errorMessage === "string"
                ? errMeta.errorMessage
                : errMeta !== undefined && typeof errMeta.error === "string"
                  ? errMeta.error
                  : "unknown error";
            process.stderr.write(`error: model call failed: ${errMsg}\n`);
          }
          turnCount = event.output.metrics.turns;
          if (adminBridge !== undefined) {
            adminBridge.updateMetrics({
              turns: event.output.metrics.turns,
              totalTokens: event.output.metrics.totalTokens,
            });
            // Accumulate real cost (costUsd is per-run, not cumulative)
            const m = event.output.metrics as unknown as Record<string, unknown>;
            if (typeof m.costUsd === "number") {
              totalCostUsd += m.costUsd;
            } else {
              totalCostUsd += costCalculator.calculate(
                modelName,
                event.output.metrics.inputTokens ?? 0,
                event.output.metrics.outputTokens ?? 0,
              );
            }
          }
        }
      }
      // Retry once on empty model response (transient API errors / rate limits)
      if (turnCount === 0 && deltas.length === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        for await (const event of runtime.run(input)) {
          if (event.kind === "text_delta") deltas.push(event.delta);
          if (event.kind === "done") {
            if (event.output.stopReason === "error") {
              const errMeta = event.output.metadata as Record<string, unknown> | undefined;
              const errDetail =
                errMeta !== undefined && typeof errMeta.errorMessage === "string"
                  ? errMeta.errorMessage
                  : "unknown error";
              process.stderr.write(`error: model call failed on retry: ${errDetail}\n`);
            }
            turnCount = event.output.metrics.turns;
            if (adminBridge !== undefined) {
              adminBridge.updateMetrics({
                turns: event.output.metrics.turns,
                totalTokens: event.output.metrics.totalTokens,
              });
            }
          }
        }
        if (turnCount === 0 && deltas.length === 0) {
          process.stderr.write(
            "warn: model returned empty response after retry. Try starting a fresh session.\n",
          );
        }
      }
      await persistChatExchangeSafely(
        workspaceRoot,
        persistAgentId,
        threadId,
        text,
        deltas.join(""),
      );
      if (nexusClient !== undefined) {
        persistChatToNexus(
          nexusClient,
          manifest.name,
          currentSessionId,
          text,
          deltas.join(""),
        ).catch((e: unknown) => {
          process.stderr.write(
            `warn: Nexus chat persist failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        });
      }

      // Auto-pause harness after copilot run if plan_autonomous was called.
      // Transitions active → suspended so the scheduler can resume sub-sessions.
      if (autonomous !== undefined) {
        const hs = autonomous.harness.status();
        if (hs.phase === "active") {
          process.stderr.write(
            "[autonomous] copilot run finished — pausing harness for scheduler\n",
          );
          await autonomous.pauseHarness({
            sessionId: `copilot-${String(hs.currentSessionSeq ?? 0)}`,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: turnCount,
              durationMs: 0,
            },
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[dispatch] ERROR: ${message}\n`);
      if (error instanceof Error && error.stack) {
        process.stderr.write(
          `[dispatch] stack: ${error.stack.split("\n").slice(0, 3).join("\n")}\n`,
        );
      }
    } finally {
      process.stderr.write(`[dispatch] finished, tuiProcessing=false\n`);
      tuiProcessing = false;
    }
  });

  // When TUI is attached, skip CLI channel (stdin conflicts with TUI raw mode)
  // but keep other channels (Telegram, Slack, etc.) for inbound message handling.
  const subscribedChannels = tuiAttached ? channels.filter((ch) => ch.name !== "cli") : channels;

  const unsubscribers = subscribedChannels.map((ch) =>
    ch.onMessage(async (inbound) => {
      const text = extractTextFromBlocks(inbound.content);
      if (text.trim() === "") return;
      if (channelProcessing) {
        output.warn("still processing previous message, please wait");
        return;
      }
      channelProcessing = true;
      // On first turn of a resumed session, keep the original thread key
      // so conversation middleware loads the existing history.
      const isResumedFirstTurn = flags.resume !== undefined && currentUpThreadKey === flags.resume;
      if (!isResumedFirstTurn) {
        sessionCounter++;
        currentSessionId = `up:${manifest.name}:${String(sessionCounter)}`;
        currentUpThreadKey = currentSessionId;
      }
      // Update context-arena message buffer before engine run
      currentUpMessages = [inbound];
      const input: EngineInput = { kind: "text", text };
      try {
        const deltas: string[] = [];
        for await (const event of runtime.run(input)) {
          if (controller.signal.aborted) break;
          // Only render to CLI stdout for CLI channel messages
          if (ch.name === "cli") renderEvent(event, { verbose: flags.verbose });
          if (event.kind === "text_delta") deltas.push(event.delta);
          if (event.kind === "done" && adminBridge !== undefined) {
            adminBridge.updateMetrics({
              turns: event.output.metrics.turns,
              totalTokens: event.output.metrics.totalTokens,
            });
            // Accumulate real cost (costUsd is per-run, not cumulative)
            const m = event.output.metrics as unknown as Record<string, unknown>;
            if (typeof m.costUsd === "number") {
              totalCostUsd += m.costUsd;
            } else {
              totalCostUsd += costCalculator.calculate(
                modelName,
                event.output.metrics.inputTokens ?? 0,
                event.output.metrics.outputTokens ?? 0,
              );
            }
          }
        }
        // Route response back to the originating channel (e.g. Telegram, Slack)
        // so non-CLI channels receive the agent's reply.
        if (ch.name !== "cli" && deltas.length > 0 && inbound.threadId !== undefined) {
          await ch.send({
            content: [{ kind: "text", text: deltas.join("") }],
            threadId: inbound.threadId,
          });
        }
        await persistChatExchangeSafely(
          workspaceRoot,
          persistAgentId,
          currentSessionId,
          text,
          deltas.join(""),
        );
        if (nexusClient !== undefined) {
          persistChatToNexus(
            nexusClient,
            manifest.name,
            currentSessionId,
            text,
            deltas.join(""),
          ).catch((e: unknown) => {
            process.stderr.write(
              `warn: Nexus chat persist failed: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          });
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          output.error(message);
        }
      } finally {
        channelProcessing = false;
      }
    }),
  );

  await new Promise<void>((r) => {
    controller.signal.addEventListener("abort", () => r(), { once: true });
  });

  // Cleanup
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  if (schedulerCron !== undefined) schedulerCron.stop();
  if (tuiApp !== undefined) await tuiApp.stop();
  clearTerminalState();
  process.removeListener("exit", forceRestoreTerminal);
  for (const unsub of unsubscribers) unsub();
  for (const ch of channels) await ch.disconnect();
  if (stopHealth !== undefined) stopHealth();
  if (stopAdmin !== undefined) stopAdmin();
  if (adminDispatcher !== undefined) await adminDispatcher.dispose();
  if (temporalAdmin !== undefined) await temporalAdmin.dispose();
  if (temporalEmbedHandle !== undefined) await temporalEmbedHandle.dispose();
  await runtime.dispose();
  if (contextArenaDispose !== undefined) await contextArenaDispose();
  for (const dispose of activatedStacks.disposables) await dispose();
  if (stopNode !== undefined) await stopNode();
  if (stopGateway !== undefined) await stopGateway();
  if (autonomous !== undefined) await autonomous.dispose();
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) await sandboxBridge.dispose();
  if (nexus.dispose !== undefined) await nexus.dispose();
  // Nexus containers are NOT stopped on quit — they persist data across sessions.
  // Use `nexus down` or `docker compose down` to explicitly stop them.

  output.info("Goodbye.");
}

/**
 * Create a lightweight model call function for the ACE reflector/curator.
 *
 * Supports both Anthropic (direct) and OpenRouter. Returns undefined
 * when no API key is available (ACE falls back to stat-only pipeline).
 */
async function createAceModelCall(): Promise<
  ((messages: readonly import("@koi/core/message").InboundMessage[]) => Promise<string>) | undefined
> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Prefer OpenRouter if available (works with any provider key)
  if (openRouterKey !== undefined && openRouterKey.length > 0) {
    const model = "anthropic/claude-3.5-haiku";
    return async (messages) => {
      const mapped = messages.map((m) => ({
        role: "user" as const,
        content: m.content.map((c) => (c.kind === "text" ? c.text : JSON.stringify(c))).join("\n"),
      }));
      const resp = await globalThis.fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: mapped, max_tokens: 1024 }),
      });
      if (!resp.ok) return "";
      const json = (await resp.json()) as {
        readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
      };
      return json.choices?.[0]?.message?.content ?? "";
    };
  }

  // Fall back to Anthropic SDK if ANTHROPIC_API_KEY is a real Anthropic key
  if (anthropicKey !== undefined && anthropicKey.length > 0 && !anthropicKey.startsWith("sk-or-")) {
    const { createAnthropicAdapter } = await import("@koi/model-router");
    const adapter = createAnthropicAdapter({ apiKey: anthropicKey });
    const aceModel = "claude-haiku-4-5-20251001";
    return async (messages) => {
      const koiMessages = messages.map((m) => ({
        ...m,
        content: m.content.map((c) =>
          c.kind === "text" ? c : { kind: "text" as const, text: JSON.stringify(c) },
        ),
      }));
      const response = await adapter.complete({
        messages: koiMessages,
        model: aceModel,
        maxTokens: 1024,
      });
      return typeof response.content === "string" ? response.content : "";
    };
  }

  return undefined;
}
