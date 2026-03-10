#!/usr/bin/env bun

/**
 * CLI entry point — routes to subcommands via command registry.
 */

import type { CliFlags } from "./args.js";
import {
  isDeployFlags,
  isDoctorFlags,
  isInitFlags,
  isLogsFlags,
  isServeFlags,
  isStartFlags,
  isStatusFlags,
  isStopFlags,
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
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flags = parseArgs(process.argv.slice(2));

const matched = COMMANDS.find((cmd) => cmd.match(flags));

if (matched !== undefined) {
  await matched.run(flags);
} else {
  process.stderr.write(`Unknown command: ${flags.command ?? "(none)"}\n`);
  process.stderr.write("Usage:\n");
  for (const cmd of COMMANDS) {
    process.stderr.write(`  ${cmd.description}\n`);
  }
  process.stderr.write("\nFlags:\n");
  process.stderr.write("  --dashboard            Enable admin dashboard (serve, start)\n");
  process.stderr.write(
    "  --dashboard-port PORT  Dashboard port (serve only, defaults to health port)\n",
  );
  process.exit(1);
}
