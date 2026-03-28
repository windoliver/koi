#!/usr/bin/env bun

/**
 * CLI entry point — routes to subcommands via command registry.
 */

import type { CliFlags } from "./args.js";
import {
  isAdminFlags,
  isDemoFlags,
  isDeployFlags,
  isDoctorFlags,
  isForgeFlags,
  isInitFlags,
  isLogsFlags,
  isReplayFlags,
  isServeFlags,
  isSessionsFlags,
  isStartFlags,
  isStatusFlags,
  isStopFlags,
  isTuiFlags,
  isUpFlags,
  parseArgs,
} from "./args.js";
import { runInit } from "./commands/init.js";
import { runStart } from "./commands/start.js";

// ---------------------------------------------------------------------------
// Command registry — maps flags to runners
// ---------------------------------------------------------------------------

interface CommandEntry {
  readonly match: (flags: CliFlags) => boolean;
  readonly run: (flags: CliFlags) => Promise<void>;
  readonly description: string;
}

/**
 * Factory for lazy-loaded command entries. Dynamic-imports the module on first
 * invocation, extracts the named export, and forwards the narrowed flags.
 */
function defineLazyCommand<
  TModule extends Record<string, unknown>,
  TKey extends string & keyof TModule,
>(
  match: (flags: CliFlags) => boolean,
  loader: () => Promise<TModule>,
  exportName: TKey,
  description: string,
): CommandEntry {
  return {
    match,
    run: async (f) => {
      const mod = await loader();
      const runner = mod[exportName] as (flags: CliFlags) => Promise<void>;
      return runner(f);
    },
    description,
  };
}

const COMMANDS: readonly CommandEntry[] = [
  {
    match: isInitFlags,
    run: (f) => runInit(f as Parameters<typeof runInit>[0]),
    description: "koi init [directory]   Create a new agent",
  },
  defineLazyCommand(
    isUpFlags,
    () => import("./commands/up.js"),
    "runUp",
    "koi up [manifest]      Start everything (runtime + admin + TUI)",
  ),
  {
    match: isStartFlags,
    run: (f) => runStart(f as Parameters<typeof runStart>[0]),
    description: "koi start [manifest]   Start an agent interactively",
  },
  defineLazyCommand(
    isServeFlags,
    () => import("./commands/serve.js"),
    "runServe",
    "koi serve [manifest]   Run agent headless (for services)",
  ),
  defineLazyCommand(
    isAdminFlags,
    () => import("./commands/admin.js"),
    "runAdmin",
    "koi admin [manifest]   Standalone admin panel server",
  ),
  defineLazyCommand(
    isDemoFlags,
    () => import("./commands/demo.js"),
    "runDemo",
    "koi demo <init|list|reset> [pack]  Manage demo data",
  ),
  defineLazyCommand(
    isSessionsFlags,
    () => import("./commands/sessions.js"),
    "runSessions",
    "koi sessions [list]    List chat sessions",
  ),
  defineLazyCommand(
    isForgeFlags,
    () => import("./commands/forge.js"),
    "runForge",
    "koi forge <cmd>        Manage community bricks",
  ),
  defineLazyCommand(
    isDeployFlags,
    () => import("./commands/deploy.js"),
    "runDeploy",
    "koi deploy [manifest]  Install/uninstall OS service",
  ),
  defineLazyCommand(
    isStatusFlags,
    () => import("./commands/status.js"),
    "runStatus",
    "koi status [manifest]  Check service status",
  ),
  defineLazyCommand(
    isStopFlags,
    () => import("./commands/stop.js"),
    "runStop",
    "koi stop [manifest]    Stop the service",
  ),
  defineLazyCommand(
    isLogsFlags,
    () => import("./commands/logs.js"),
    "runLogs",
    "koi logs [manifest]    View service logs",
  ),
  defineLazyCommand(
    isDoctorFlags,
    () => import("./commands/doctor.js"),
    "runDoctor",
    "koi doctor [manifest]  Diagnose service health",
  ),
  defineLazyCommand(
    isReplayFlags,
    () => import("./commands/replay.js"),
    "runReplay",
    "koi replay             Replay agent state at a specific turn",
  ),
  defineLazyCommand(
    isTuiFlags,
    () => import("./commands/tui.js"),
    "runTui",
    "koi tui                Interactive terminal console",
  ),
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flags = parseArgs(process.argv.slice(2));

const matched = COMMANDS.find((cmd) => cmd.match(flags));

if (matched !== undefined) {
  await matched.run(flags);
} else if (flags.command === undefined || flags.command === null) {
  // No subcommand: check for koi.yaml, launch TUI accordingly
  const { existsSync } = await import("node:fs");
  if (existsSync("koi.yaml")) {
    // Manifest exists — run `koi up` flow
    const { runUp } = await import("./commands/up.js");
    await runUp(flags as Parameters<typeof runUp>[0]);
  } else {
    // No manifest — launch TUI in welcome mode
    const { runTui } = await import("./commands/tui.js");
    await runTui({
      command: "tui",
      directory: flags.directory,
      url: undefined,
      authToken: undefined,
      refresh: 5,
      agent: undefined,
      session: undefined,
      mode: "welcome",
      nexusSource: undefined,
      nexusBuild: false,
      nexusPort: undefined,
    });
  }
} else {
  process.stderr.write(`Unknown command: ${flags.command}\n`);
  process.stderr.write("Usage:\n");
  for (const cmd of COMMANDS) {
    process.stderr.write(`  ${cmd.description}\n`);
  }
  process.stderr.write("\nFlags:\n");
  process.stderr.write("  --admin                Enable admin panel (serve, start)\n");
  process.stderr.write(
    "  --admin-port PORT      Admin panel port (serve only, defaults to health port)\n",
  );
  process.stderr.write(
    "  --nexus-source PATH    Nexus source directory (uv run --directory PATH nexus)\n",
  );
  process.stderr.write(
    "  --nexus-build          Run uv sync in source dir before starting Nexus\n",
  );
  process.exit(1);
}
