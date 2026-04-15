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

// Fast-path: top-level --version / --help exit before loading dispatch.
// Only triggers when no subcommand precedes the flag — `koi start --help`
// must reach dispatch so it can print the per-command help block (#1729).
// A subcommand is detected by "first arg exists and is not a flag".
//
// NOTE on `--`: a top-level `koi -- --version` ought to treat --version
// as a literal operand, not a version probe, but we cannot prove that
// path end-to-end: Bun itself consumes the first `--` from its argv
// before the shim is invoked, so a dev-mode test via `bun bin.ts --
// --version` is indistinguishable from `bun bin.ts --version`. Rather
// than ship behavior we can't verify, the fast-path keeps the simpler
// includes() scan and does not claim `--` support at the top level.
// Subcommand-level `--` (e.g. `koi plugin install -- --help`) IS
// honored by parseArgs / typedParseArgs and is regression-tested.
const firstArg = rawArgv[0];
const hasSubcommand = firstArg !== undefined && !firstArg.startsWith("-");

if (!hasSubcommand) {
  if (rawArgv.includes("--version") || rawArgv.includes("-V")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (rawArgv.includes("--help") || rawArgv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
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
    const { installTuiReexecSignalHandlers } = await import("./tui-reexec-signals.js");
    installTuiReexecSignalHandlers(proc);
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
