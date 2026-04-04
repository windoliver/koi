#!/usr/bin/env bun

/**
 * CLI entry point.
 *
 * Fast-path: --version and --help are checked against raw process.argv BEFORE
 * any module is loaded. Static `import` statements are hoisted in ESM and
 * cannot be deferred, so the args module is loaded via `await import()` below
 * to preserve this invariant.
 */

import type { CliFlags } from "./args.js";

const VERSION = "0.0.0";

const HELP = `koi v${VERSION} — agent engine CLI

Usage:
  koi <command> [options]

Commands:
  init [directory]       Create a new agent
  start [manifest]       Start an agent interactively
  serve [manifest]       Run agent headless (for services)
  tui                    Interactive terminal console
  sessions [list]        List chat sessions
  logs [manifest]        View service logs
  status [manifest]      Check service status
  doctor [manifest]      Diagnose service health
  stop [manifest]        Stop the service
  deploy [manifest]      Install/uninstall OS service

Global flags:
  --version, -V          Show version
  --help, -h             Show this help
`;

const rawArgv = process.argv.slice(2);

if (rawArgv.includes("--version") || rawArgv.includes("-V")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (rawArgv.includes("--help") || rawArgv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Lazy-load args module now that fast-path is cleared.
const { COMMAND_NAMES, isKnownCommand, parseArgs, ParseError } = await import("./args.js");

let flags: CliFlags;
try {
  flags = parseArgs(rawArgv);
} catch (e: unknown) {
  if (e instanceof ParseError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (flags.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (flags.command === undefined) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (isKnownCommand(flags.command)) {
  process.stderr.write(`koi ${flags.command}: not yet implemented\n`);
  process.exit(1);
}

process.stderr.write(`Unknown command: ${flags.command}\n`);
process.stderr.write(`\nAvailable commands:\n`);
for (const name of COMMAND_NAMES) {
  process.stderr.write(`  ${name}\n`);
}
process.exit(1);
