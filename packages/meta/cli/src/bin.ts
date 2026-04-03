#!/usr/bin/env bun

/**
 * CLI entry point — fast-path for --version/--help, then dispatches to
 * subcommand parsers. Actual command runners are wired in #1263.
 */

import { COMMAND_NAMES, parseArgs } from "./args.js";

const VERSION = "0.0.0";

function printHelp(): void {
  const help = `koi v${VERSION} — agent engine CLI

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
  process.stdout.write(help);
}

const flags = parseArgs(process.argv.slice(2));

if (flags.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (flags.help) {
  printHelp();
  process.exit(0);
}

if (flags.command === undefined) {
  printHelp();
  process.exit(0);
}

if (COMMAND_NAMES.includes(flags.command)) {
  process.stderr.write(`koi ${flags.command}: not yet implemented\n`);
  process.exit(1);
}

process.stderr.write(`Unknown command: ${flags.command}\n`);
process.stderr.write(`\nAvailable commands:\n`);
for (const name of COMMAND_NAMES) {
  process.stderr.write(`  ${name}\n`);
}
process.exit(1);
