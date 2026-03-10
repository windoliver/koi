/**
 * `koi admin` command — standalone admin panel server.
 *
 * Starts an HTTP server that serves the admin panel dashboard API
 * without running an agent. Reads the manifest for agent metadata
 * (name, type, model, channels, skills) and creates a bridge-backed
 * data source so the admin panel reflects the manifest configuration.
 *
 * Two ways to access the admin panel:
 * - `koi admin [manifest]`       — standalone server (this command)
 * - `koi serve --admin [manifest]` — embedded with the running agent
 */

import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";
import type { AdminFlags } from "../args.js";
import { createLocalFileSystem, resolveDashboardAssetsDir } from "../helpers.js";

const DEFAULT_ADMIN_PORT = 3100;

export async function runAdmin(flags: AdminFlags): Promise<void> {
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

  const bridge = createAdminPanelBridge({
    agentName: manifest.name,
    agentType: manifest.lifecycle ?? "copilot",
    model: manifest.model.name,
    channels: channelNames,
    skills: skillNames,
    fileSystem,
  });

  const assetsDir = resolveDashboardAssetsDir();
  const dashboardResult = createDashboardHandler(bridge, {
    cors: true,
    ...(assetsDir !== undefined ? { assetsDir } : {}),
  });

  // 3. Start HTTP server
  const port = flags.port ?? DEFAULT_ADMIN_PORT;

  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const adminResponse = await dashboardResult.handler(req);
      if (adminResponse !== null) return adminResponse;
      return new Response("Not Found", { status: 404 });
    },
  });

  const dashboardUrl = `http://localhost:${String(server.port)}/dashboard`;
  process.stderr.write(`Admin panel for "${manifest.name}" on ${dashboardUrl}\n`);

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
      exec(`${openCmd} ${dashboardUrl}`);
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

  process.stderr.write("Goodbye.\n");
}
