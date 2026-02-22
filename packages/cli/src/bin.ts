#!/usr/bin/env bun

/**
 * CLI entry point — routes to subcommands.
 */

import { parseArgs } from "./args.js";
import { runInit } from "./commands/init.js";

const flags = parseArgs(process.argv.slice(2));

switch (flags.command) {
  case "init":
    await runInit(flags);
    break;
  default:
    console.error(`Unknown command: ${flags.command ?? "(none)"}`);
    console.error(
      "Usage: koi init [directory] [--yes] [--name <name>] [--template <template>] [--model <model>]",
    );
    process.exit(1);
}
