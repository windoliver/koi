/**
 * `koi admin` command — standalone admin panel server.
 *
 * Starts an HTTP server that serves the admin panel dashboard API
 * without running an agent. Reads the manifest for agent metadata
 * (name, type, model, channels, skills) and creates a bridge-backed
 * data source so the admin panel reflects the manifest configuration.
 *
 * Three ways to access the admin panel:
 * - `koi admin [manifest]`              — standalone (embedded agent with manifest fallback)
 * - `koi admin --connect localhost:9100` — proxy to running koi serve
 * - `koi serve --admin [manifest]`      — embedded with the running agent
 */

import type { EngineEvent, EngineInput } from "@koi/core";
import type { DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { DashboardEvent } from "@koi/dashboard-types";
import { DEFAULT_DASHBOARD_CONFIG } from "@koi/dashboard-types";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";
import { createAgentDispatcher } from "../agent-dispatcher.js";
import type { AgentChatBridge } from "../agui-chat-bridge.js";
import type { AdminFlags } from "../args.js";
import { createChatRouter } from "../chat-router.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchange,
  resolveDashboardAssetsDir,
} from "../helpers.js";
import { resolveAutonomousOrWarn } from "../resolve-autonomous.js";
import { resolveOrchestrationFromAgent } from "../resolve-orchestration.js";
import { resolveTemporalOrWarn } from "../resolve-temporal.js";

const DEFAULT_ADMIN_PORT = 9200;

// ---------------------------------------------------------------------------
// Remote proxy mode — connect to a running koi serve instance
// ---------------------------------------------------------------------------

/**
 * Create a reverse-proxy dashboard handler that forwards API requests
 * to a running koi serve instance and serves static assets locally.
 */
function createProxyHandler(remoteBaseUrl: string): DashboardHandlerResult {
  const basePath = DEFAULT_DASHBOARD_CONFIG.basePath;
  const apiPath = DEFAULT_DASHBOARD_CONFIG.apiPath;
  const assetsDir = resolveDashboardAssetsDir();

  // Import static serve lazily (only needed in proxy mode)
  // let justified: set inside handler, read for asset serving
  let staticServeFn: ((pathname: string) => Promise<Response | null>) | undefined;

  const handler = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);

    // Forward SSE events endpoint (must be checked before generic API forwarding
    // because /admin/api/events would otherwise match the apiPath prefix)
    if (url.pathname === `${apiPath}/events` || url.pathname === `${basePath}/events`) {
      try {
        const targetUrl = `${remoteBaseUrl}${url.pathname}${url.search}`;
        // SSE is indefinite — use the client's own abort signal so the
        // connection lives as long as the browser tab stays open.
        const proxyRes = await fetch(targetUrl, {
          headers: req.headers,
          signal: req.signal,
        });

        const headers = new Headers(proxyRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");

        return new Response(proxyRes.body, {
          status: proxyRes.status,
          headers,
        });
      } catch {
        return new Response("event: error\ndata: upstream unavailable\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
    }

    // Forward API requests to remote server
    if (url.pathname.startsWith(apiPath)) {
      try {
        const targetUrl = `${remoteBaseUrl}${url.pathname}${url.search}`;
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          signal: AbortSignal.timeout(30_000),
        });

        // Clone response with CORS headers
        const headers = new Headers(proxyRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");

        return new Response(proxyRes.body, {
          status: proxyRes.status,
          statusText: proxyRes.statusText,
          headers,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ ok: false, error: { message: msg } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Serve static assets locally (strip basePath like handler.ts does)
    if (url.pathname.startsWith(basePath) && assetsDir !== undefined) {
      if (staticServeFn === undefined) {
        const { createStaticServe } = await import("@koi/dashboard-api");
        const result = createStaticServe(assetsDir);
        staticServeFn = result.serve;
      }
      const assetPath = url.pathname.slice(basePath.length) || "/index.html";
      const response = await staticServeFn(assetPath);
      if (response !== null) return response;

      // SPA fallback — serve index.html for non-file paths
      if (!assetPath.includes(".")) {
        return staticServeFn("/index.html");
      }
    }

    return null;
  };

  return {
    handler,
    dispose(): void {
      // No resources to clean up in proxy mode
    },
  };
}

// ---------------------------------------------------------------------------
// Health probe — check if a remote koi serve instance is reachable
// ---------------------------------------------------------------------------

async function probeRemoteHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Probe whether the admin panel is actually running at the given base URL.
 * Checks the dashboard-specific health endpoint (/admin/api/health) which
 * only exists when --admin is enabled. A plain koi serve without --admin
 * passes probeRemoteHealth but fails this check.
 */
async function probeAdminPanel(baseUrl: string): Promise<boolean> {
  try {
    const apiPath = DEFAULT_DASHBOARD_CONFIG.apiPath; // "/admin/api"
    const res = await fetch(`${baseUrl}${apiPath}/health`, { signal: AbortSignal.timeout(3_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runAdmin(flags: AdminFlags): Promise<void> {
  const port = flags.port ?? DEFAULT_ADMIN_PORT;

  // ── Remote proxy mode ──────────────────────────────────────────────────
  if (flags.connect !== undefined) {
    const remoteUrl = flags.connect.startsWith("http") ? flags.connect : `http://${flags.connect}`;

    // Probe remote health before starting proxy
    const healthy = await probeRemoteHealth(remoteUrl);
    if (!healthy) {
      process.stderr.write(`Cannot connect to running agent at ${remoteUrl}\n`);
      process.stderr.write("Make sure koi serve --admin is running at that address.\n");
      process.exit(1);
    }

    // Verify that the admin panel is actually running (not just a plain koi serve)
    const adminAvailable = await probeAdminPanel(remoteUrl);
    if (!adminAvailable) {
      process.stderr.write(`Agent at ${remoteUrl} is reachable but admin panel is not enabled.\n`);
      process.stderr.write("Start with: koi serve --admin\n");
      process.exit(1);
    }

    if (flags.verbose) {
      process.stderr.write(`Connected to remote agent at ${remoteUrl}\n`);
    }

    const dashboardResult = createProxyHandler(remoteUrl);

    const server = Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const adminResponse = await dashboardResult.handler(req);
        if (adminResponse !== null) return adminResponse;
        return new Response("Not Found", { status: 404 });
      },
    });

    const adminUrl = `http://localhost:${String(server.port)}/admin`;
    process.stderr.write(`Admin panel (proxy → ${remoteUrl}) on ${adminUrl}\n`);

    if (flags.open) {
      try {
        const { exec } = await import("node:child_process");
        const openCmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${openCmd} ${adminUrl}`);
      } catch {
        // Non-fatal
      }
    }

    process.stderr.write("Press Ctrl+C to stop.\n");

    const controller = new AbortController();
    function shutdown(): void {
      controller.abort();
    }
    process.on("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    server.stop(true);
    dashboardResult.dispose();
    process.stderr.write("Goodbye.\n");
    return;
  }

  // ── Auto-discovery: probe default serve port before manifest fallback ──
  // Uses probeAdminPanel (not probeRemoteHealth) so a plain koi serve
  // without --admin doesn't trigger a broken proxy.

  const DEFAULT_SERVE_PORT = 9100;
  const probeUrl = `http://localhost:${String(DEFAULT_SERVE_PORT)}`;
  const discovered = await probeAdminPanel(probeUrl);

  if (discovered) {
    if (flags.verbose) {
      process.stderr.write(`Discovered running agent at ${probeUrl} — proxying\n`);
    }

    const dashboardResult = createProxyHandler(probeUrl);

    const server = Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const adminResponse = await dashboardResult.handler(req);
        if (adminResponse !== null) return adminResponse;
        return new Response("Not Found", { status: 404 });
      },
    });

    const adminUrl = `http://localhost:${String(server.port)}/admin`;
    process.stderr.write(
      `Admin panel (discovered agent at :${String(DEFAULT_SERVE_PORT)}) on ${adminUrl}\n`,
    );

    if (flags.open) {
      try {
        const { exec } = await import("node:child_process");
        const openCmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${openCmd} ${adminUrl}`);
      } catch {
        // Non-fatal
      }
    }

    process.stderr.write("Press Ctrl+C to stop.\n");

    const controller = new AbortController();
    function shutdown(): void {
      controller.abort();
    }
    process.on("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    server.stop(true);
    dashboardResult.dispose();
    process.stderr.write("Goodbye.\n");
    return;
  }

  // ── Standalone mode (manifest-based fallback) ──────────────────────────

  // 1. Load manifest for agent metadata
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";

  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest, warnings } = loadResult.value;

  for (const warning of warnings) {
    process.stderr.write(`warn: ${warning.message}\n`);
  }

  // 2. Create bridge with manifest metadata
  const channelNames = (manifest.channels ?? []).map((ch) => {
    if (typeof ch === "string") return ch;
    return (ch as { readonly name: string }).name;
  });
  const skillNames = (manifest.skills ?? []).map((s) => s.name);

  // Resolve workspace root from manifest path for file browsing
  const { dirname: pathDirname, resolve: pathResolve } = await import("node:path");
  const workspaceRoot = pathResolve(pathDirname(manifestPath));
  const fileSystem = createLocalFileSystem(workspaceRoot);

  // 2b. Resolve all orchestration sources
  const temporal = await resolveTemporalOrWarn(flags.temporalUrl, flags.verbose);
  const autonomous = await resolveAutonomousOrWarn(manifest, flags.verbose);

  // 3. Try to boot embedded agent runtime for live orchestration + ECS scan.
  //    Falls back to manifest-only mode if resolution fails (e.g., missing API keys).
  // let justified: set in try when embedded runtime boots, read for bridge orchestration
  let embeddedOrch: ReturnType<typeof resolveOrchestrationFromAgent> | undefined;
  // let justified: set in try when runtime created, called at cleanup
  let runtimeDispose: (() => Promise<void>) | undefined;
  // let justified: captured from embedded runtime for chat dispatch
  let runtimeRef: { readonly run: (input: EngineInput) => AsyncIterable<EngineEvent> } | undefined;

  // Late-binding event sink for forge/monitor SSE events
  // let justified: mutable ref set when admin bridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  // Create chat bridge for agent chat endpoint in standalone mode
  // let justified: conditionally set, read for dashboard handler
  let chatBridge: AgentChatBridge | undefined;
  {
    const { createAgentChatBridge } = await import("../agui-chat-bridge.js");
    chatBridge = createAgentChatBridge();
  }

  try {
    const [{ resolveAgent }, { createForgeConfiguredKoi }, { createPiAdapter }] = await Promise.all(
      [import("../resolve-agent.js"), import("@koi/forge"), import("@koi/engine-pi")],
    );

    const resolved = await resolveAgent({ manifestPath, manifest });
    if (resolved.ok) {
      const adapter = resolved.value.engine ?? createPiAdapter({ model: manifest.model.name });
      const { runtime } = await createForgeConfiguredKoi({
        manifest,
        adapter,
        middleware: [
          ...resolved.value.middleware,
          ...(autonomous?.middleware ?? []),
          ...(chatBridge !== undefined ? [chatBridge.middleware] : []),
        ],
        providers: [...(autonomous?.providers ?? [])],
        extensions: [],
        onDashboardEvent: (event: DashboardEvent) => {
          emitDashboardEvent?.(event);
        },
      });

      embeddedOrch = resolveOrchestrationFromAgent({
        agent: runtime.agent,
        temporal,
        ...(autonomous !== undefined ? { harness: autonomous.harness } : {}),
        verbose: flags.verbose,
      });
      runtimeDispose = () => runtime.dispose();
      runtimeRef = runtime;

      if (flags.verbose) {
        process.stderr.write("Embedded agent runtime: active\n");
      }
    } else if (flags.verbose) {
      process.stderr.write("warn: agent resolution failed, using manifest-only mode\n");
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flags.verbose) {
      process.stderr.write(`warn: embedded agent unavailable: ${msg}\n`);
    }
  }

  // Fall back to non-agent orchestration if embedded runtime unavailable
  const orch =
    embeddedOrch ??
    resolveOrchestrationFromAgent({
      temporal,
      ...(autonomous !== undefined ? { harness: autonomous.harness } : {}),
      verbose: flags.verbose,
    });

  // Create agent dispatcher for the admin panel (allows dispatching new agents)
  const dispatcher = createAgentDispatcher({
    defaultManifestPath: manifestPath,
    verbose: flags.verbose,
    additionalMiddleware: [...(autonomous?.middleware ?? [])],
    additionalProviders: [...(autonomous?.providers ?? [])],
    onDashboardEvent: (event) => {
      emitDashboardEvent?.(event as DashboardEvent);
    },
  });

  const bridge = createAdminPanelBridge({
    agentName: manifest.name,
    agentType: manifest.lifecycle ?? "copilot",
    model: manifest.model.name,
    channels: channelNames,
    skills: skillNames,
    fileSystem,
    dispatchAgent: dispatcher.dispatchAgent,
    onTerminateAgent: async (id) => {
      await dispatcher.terminateAgent(id);
    },
    ...(orch.hasAny
      ? {
          orchestration: orch.orchestration,
          orchestrationCommands: orch.orchestrationCommands,
        }
      : {}),
  });

  // Wire forge/monitor SSE event sink now that the bridge exists
  emitDashboardEvent = bridge.emitEvent;

  // Wire chat dispatch if embedded runtime is available
  if (chatBridge !== undefined && runtimeRef !== undefined) {
    const run = runtimeRef;
    // let justified: concurrency guard for single-threaded agent
    let chatProcessing = false;
    chatBridge.wireDispatch(async (msg) => {
      if (chatProcessing) throw new Error("Agent is busy processing another request");
      chatProcessing = true;
      try {
        const text = extractTextFromBlocks(msg.content);
        if (text.trim() === "") return;
        const threadId = msg.threadId ?? `chat-${Date.now().toString(36)}`;
        const input: EngineInput = { kind: "text", text };
        const deltas: string[] = [];
        for await (const event of run.run(input)) {
          if (event.kind === "text_delta") deltas.push(event.delta);
          if (event.kind === "done") {
            const m = event.output.metrics;
            bridge.updateMetrics({ turns: m.turns, totalTokens: m.totalTokens });
          }
        }
        // Persist to shared chat log (best-effort)
        await persistChatExchange(
          workspaceRoot,
          bridge.agentId,
          threadId,
          text,
          deltas.join(""),
        ).catch(() => {});
      } finally {
        chatProcessing = false;
      }
    });
  }

  // Build routing chat handler: primary agent → chatBridge, dispatched agents → dispatcher
  const routingChatHandler =
    chatBridge !== undefined
      ? createChatRouter({
          primaryHandler: chatBridge.handler,
          getDispatchedHandler: dispatcher.getChatHandler,
          isPrimaryAgent: (id) => id === bridge.agentId,
        })
      : undefined;

  const assetsDir = resolveDashboardAssetsDir();
  const dashboardResult = createDashboardHandler(
    {
      ...bridge,
      ...(routingChatHandler !== undefined ? { agentChatHandler: routingChatHandler } : {}),
    },
    {
      cors: true,
      ...(assetsDir !== undefined ? { assetsDir } : {}),
    },
  );

  // 3. Start HTTP server
  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const adminResponse = await dashboardResult.handler(req);
      if (adminResponse !== null) return adminResponse;
      return new Response("Not Found", { status: 404 });
    },
  });

  const adminUrl = `http://localhost:${String(server.port)}/admin`;
  process.stderr.write(`Admin panel for "${manifest.name}" on ${adminUrl}\n`);

  if (flags.verbose) {
    process.stderr.write(`Manifest: ${manifestPath}\n`);
    process.stderr.write(`Model: ${manifest.model.name}\n`);
  }

  // Auto-open browser unless --no-open
  if (flags.open) {
    try {
      const { exec } = await import("node:child_process");
      const openCmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      exec(`${openCmd} ${adminUrl}`);
    } catch {
      // Non-fatal — browser open is best-effort
    }
  }

  process.stderr.write("Press Ctrl+C to stop.\n");

  // 4. Wait for termination signal
  const controller = new AbortController();

  function shutdown(): void {
    controller.abort();
  }

  process.on("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  // 5. Cleanup
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  server.stop(true);
  dashboardResult.dispose();
  await dispatcher.dispose();
  if (runtimeDispose !== undefined) {
    await runtimeDispose();
  }
  if (temporal !== undefined) {
    await temporal.dispose();
  }
  if (autonomous !== undefined) {
    await autonomous.dispose();
  }

  process.stderr.write("Goodbye.\n");
}
