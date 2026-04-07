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
import type { CommandModule } from "./types.js";

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
const { COMMAND_NAMES, isKnownCommand, isTuiFlags, parseArgs, ParseError } = await import(
  "./args.js"
);

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

// Dispatch to implemented command handlers
if (isTuiFlags(flags)) {
  // solid-js maps the "node" condition (Bun's default) to dist/server.js which
  // is the SSR build — it disables reactivity and crashes OpenTUI's renderer.
  // Re-exec the same command with --conditions browser so both @koi/tui and
  // @opentui/solid resolve solid-js to dist/solid.js (the reactive build).
  // The env marker prevents infinite re-exec loops.
  if (process.env.KOI_TUI_BROWSER_SOLID !== "1") {
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") baseEnv[k] = v;
    }
    const proc = Bun.spawn(
      [process.execPath, "--conditions", "browser", ...process.argv.slice(1)],
      {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        env: { ...baseEnv, KOI_TUI_BROWSER_SOLID: "1" },
      },
    );
    // The child inherits the same process group as the parent, so terminal
    // signals (Ctrl+C → SIGINT) are already delivered to both processes by the
    // kernel. No explicit forwarding needed — it would cause double delivery
    // and bypass the child's graceful stop() shutdown path.
    process.exit(await proc.exited);
  }
  const { runTuiCommand } = await import("./tui-command.js");
  await runTuiCommand(flags);
  process.exit(0);
}

if (isKnownCommand(flags.command)) {
  const { COMMAND_LOADERS } = await import("./registry.js");
  const loader = COMMAND_LOADERS[flags.command];

  // Justified cast: loader returns CommandModule<XxxFlags>, but flags is CliFlags.
  // The cast is safe because the parser already produced the correct flag type for
  // this command. Single cast site — no guards needed inside individual commands.
  let mod: CommandModule;
  try {
    mod = (await loader()) as CommandModule;
  } catch (e: unknown) {
    process.stderr.write(`koi ${flags.command}: failed to load command module\n`);
    if (e instanceof Error) process.stderr.write(`  ${e.message}\n`);
    process.exit(2);
  }

  const exitCode = await mod.run(flags);
  process.exit(exitCode);
}

process.stderr.write(`Unknown command: ${flags.command}\n`);
process.stderr.write(`\nAvailable commands:\n`);
for (const name of COMMAND_NAMES) {
  process.stderr.write(`  ${name}\n`);
}
process.exit(1);
