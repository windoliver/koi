#!/usr/bin/env bun

/**
 * CLI entry point.
 *
 * Fast-path: --version and --help are checked against raw process.argv BEFORE
 * any module is loaded. Static `import` statements are hoisted in ESM and
 * cannot be deferred, so the dispatch module is loaded via `await import()`
 * below to preserve this invariant.
 *
 * The post-fast-path logic (args.js load, parseArgs, TUI detection,
 * registry load, command loader) lives in ./dispatch.ts so that
 * bench-entry.ts can call exactly the same function for the
 * startup-latency CI gate (#1637). That guarantees the benchmark
 * cannot drift from the shipped dispatch path — there is no hand-
 * maintained duplicate to keep in sync.
 */

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
  plugin <subcommand>    Manage plugins (install, remove, enable, disable, update, list)

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

// Lazy-load dispatch helper now that the raw-argv fast-path is cleared.
// Shared with bench-entry.ts so startup measurement cannot drift from
// the real CLI dispatch path.
const { runDispatch } = await import("./dispatch.js");
const result = await runDispatch(rawArgv, HELP, VERSION);

switch (result.kind) {
  case "exit": {
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    process.exit(result.code);
    break;
  }
  case "tui-reexec": {
    // solid-js maps the "node" condition (Bun's default) to dist/server.js
    // which is the SSR build — it disables reactivity and crashes OpenTUI's
    // renderer. Re-exec the same command with --conditions browser so both
    // @koi/tui and @opentui/solid resolve solid-js to dist/solid.js (the
    // reactive build). The env marker prevents infinite re-exec loops.
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
    // signals (Ctrl+C → SIGINT) are already delivered to both processes by
    // the kernel. No explicit forwarding needed — it would cause double
    // delivery and bypass the child's graceful stop() shutdown path.
    process.exit(await proc.exited);
    break;
  }
  case "tui": {
    const { runTuiCommand } = await import("./tui-command.js");
    await runTuiCommand(result.flags);
    process.exit(0);
    break;
  }
  case "run": {
    const exitCode = await result.mod.run(result.flags);
    process.exit(exitCode);
    break;
  }
}
