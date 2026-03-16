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
  isInitFlags,
  isLogsFlags,
  isReplayFlags,
  isServeFlags,
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

const COMMANDS: readonly CommandEntry[] = [
  {
    match: isInitFlags,
    run: (f) => runInit(f as Parameters<typeof runInit>[0]),
    description: "koi init [directory]   Create a new agent",
  },
  {
    match: isUpFlags,
    run: async (f) => {
      const { runUp } = await import("./commands/up.js");
      return runUp(f as Parameters<typeof runUp>[0]);
    },
    description: "koi up [manifest]      Start everything (runtime + admin + TUI)",
  },
  {
    match: isStartFlags,
    run: (f) => runStart(f as Parameters<typeof runStart>[0]),
    description: "koi start [manifest]   Start an agent interactively",
  },
  {
    match: isServeFlags,
    run: async (f) => {
      const { runServe } = await import("./commands/serve.js");
      return runServe(f as Parameters<typeof runServe>[0]);
    },
    description: "koi serve [manifest]   Run agent headless (for services)",
  },
  {
    match: isAdminFlags,
    run: async (f) => {
      const { runAdmin } = await import("./commands/admin.js");
      return runAdmin(f as Parameters<typeof runAdmin>[0]);
    },
    description: "koi admin [manifest]   Standalone admin panel server",
  },
  {
    match: isDemoFlags,
    run: async (f) => {
      const { runDemo } = await import("./commands/demo.js");
      return runDemo(f as Parameters<typeof runDemo>[0]);
    },
    description: "koi demo <init|list|reset> [pack]  Manage demo data",
  },
  {
    match: isDeployFlags,
    run: async (f) => {
      const { runDeploy } = await import("./commands/deploy.js");
      return runDeploy(f as Parameters<typeof runDeploy>[0]);
    },
    description: "koi deploy [manifest]  Install/uninstall OS service",
  },
  {
    match: isStatusFlags,
    run: async (f) => {
      const { runStatus } = await import("./commands/status.js");
      return runStatus(f as Parameters<typeof runStatus>[0]);
    },
    description: "koi status [manifest]  Check service status",
  },
  {
    match: isStopFlags,
    run: async (f) => {
      const { runStop } = await import("./commands/stop.js");
      return runStop(f as Parameters<typeof runStop>[0]);
    },
    description: "koi stop [manifest]    Stop the service",
  },
  {
    match: isLogsFlags,
    run: async (f) => {
      const { runLogs } = await import("./commands/logs.js");
      return runLogs(f as Parameters<typeof runLogs>[0]);
    },
    description: "koi logs [manifest]    View service logs",
  },
  {
    match: isDoctorFlags,
    run: async (f) => {
      const { runDoctor } = await import("./commands/doctor.js");
      return runDoctor(f as Parameters<typeof runDoctor>[0]);
    },
    description: "koi doctor [manifest]  Diagnose service health",
  },
  {
    match: isReplayFlags,
    run: async (f) => {
      const { runReplay } = await import("./commands/replay.js");
      return runReplay(f as Parameters<typeof runReplay>[0]);
    },
    description: "koi replay             Replay agent state at a specific turn",
  },
  {
    match: isTuiFlags,
    run: async (f) => {
      const { runTui } = await import("./commands/tui.js");
      return runTui(f as Parameters<typeof runTui>[0]);
    },
    description: "koi tui                Interactive terminal console",
  },
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
      refresh: undefined,
      agent: undefined,
      session: undefined,
      mode: "welcome",
    } as unknown as Parameters<typeof runTui>[0]);
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
