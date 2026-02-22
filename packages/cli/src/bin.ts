#!/usr/bin/env bun

/**
 * CLI entry point — routes to subcommands.
 */

import { isInitFlags, isStartFlags, parseArgs } from "./args.js";
import { runInit } from "./commands/init.js";
import { runStart } from "./commands/start.js";

const flags = parseArgs(process.argv.slice(2));

if (isInitFlags(flags)) {
  await runInit(flags);
} else if (isStartFlags(flags)) {
  await runStart(flags);
} else {
  process.stderr.write(`Unknown command: ${flags.command ?? "(none)"}\n`);
  process.stderr.write("Usage:\n");
  process.stderr.write("  koi init [directory]  Create a new agent\n");
  process.stderr.write("  koi start [manifest]  Start an agent from koi.yaml\n");
  process.exit(1);
}
