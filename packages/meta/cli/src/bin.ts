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
  bg <subcommand>        Manage background agent sessions (ps, logs, kill, attach, detach)

Global flags:
  --version, -V          Show version
  --help, -h             Show this help
`;

const rawArgv = process.argv.slice(2);

// Fast-path: top-level --version / --help exit before loading dispatch.
// Three gates, all must hold for the fast-path to fire:
//   1. No subcommand precedes the flag — `koi start --help` must reach
//      dispatch so it can print the per-command help block (#1729).
//   2. The flag appears before the first `--` operand terminator —
//      `koi -- --version` is a literal operand request, not a version
//      probe. Matches detectGlobalFlags semantics in args/shared.ts so
//      the parser and entrypoint share one contract.
//   3. The flag is actually present.
//
// Subcommand detection: "first arg exists and is not a flag".
//
// Dev-mode testability note: Bun consumes the first `--` from its own
// argv before the shim sees it, so `bun bin.ts -- --version` can't
// express this case end-to-end under dev invocation. The behavior is
// still correct for the installed binary shim, and the `--` scan is
// unit-tested via detectGlobalFlags/parseArgs in args.test.ts.
const firstArg = rawArgv[0];
const hasSubcommand = firstArg !== undefined && !firstArg.startsWith("-");

if (!hasSubcommand) {
  let wantsVersion = false;
  let wantsHelp = false;
  for (const a of rawArgv) {
    if (a === "--") break;
    if (a === "--version" || a === "-V") wantsVersion = true;
    else if (a === "--help" || a === "-h") wantsHelp = true;
  }

  if (wantsVersion) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (wantsHelp) {
    process.stdout.write(HELP);
    process.exit(0);
  }
}

// Early SIGUSR1 handler (#1906) — installed SYNCHRONOUSLY after the fast
// path clears so the re-exec wrapper's forwarded SIGUSR1 cannot land on
// the child before any handler is armed. The install itself runs inline:
//
//   * No static import of ./tui-sigusr1.js so the fast path above stays
//     import-free (the module is still loaded later, lazily, through
//     dispatch.ts or tui-command.ts).
//   * No dynamic `await import()` either — the await would push the
//     install behind a module-resolution round-trip and re-open the race
//     the round-5 review flagged.
//
// Gate:
//   1. `rawArgv[0] === "tui"` — this invocation is specifically the TUI
//      command, not a `koi start`/`koi serve` that happens to have the
//      browser marker in its environment (scope-leak flagged in round 9).
//   2. `KOI_TUI_BROWSER_SOLID === "1"` — we are the re-exec child, not
//      the parent wrapper. The parent has its own SIGUSR1 forwarding
//      path in tui-reexec-signals.ts.
//   3. `process.platform !== "win32"` — Windows does not deliver SIGUSR1.
//
// Exit code uses a platform map mirrored from tui-sigusr1.ts's
// FALLBACK_SIGUSR1. Kept in sync by the SIGUSR1_EXIT_CODE test that
// asserts `128 + expected[platform]` on every supported host.
//
// Handler reference is stashed on globalThis via Symbol.for so
// runTuiCommand can locate and remove ONLY this specific listener
// (not every SIGUSR1 listener — an embedding host may own others).
if (
  rawArgv[0] === "tui" &&
  process.env.KOI_TUI_BROWSER_SOLID === "1" &&
  process.platform !== "win32"
) {
  const p = process.platform;
  const sigNum = p === "darwin" || p === "freebsd" || p === "netbsd" || p === "openbsd" ? 30 : 10;
  const earlyHandler = (): void => {
    process.exit(128 + sigNum);
  };
  const holder = globalThis as Record<symbol, unknown>;
  holder[Symbol.for("koi:tui:sigusr1:early-handler")] = earlyHandler;
  process.on("SIGUSR1", earlyHandler);
  // Child-ready ack (#1906 residual) — notify the re-exec parent via
  // SIGUSR2 that our SIGUSR1 handler is armed. The parent queues any
  // pending SIGUSR1 forwards and drains them on receipt of this ack,
  // closing the Bun-runtime-init race where a forwarded SIGUSR1 could
  // otherwise land mid-module-loading and SIGTRAP-panic the child.
  //
  // Best-effort: wrapped in try/catch so a missing/exited parent (e.g.
  // child spawned outside the wrapper path) doesn't abort startup.
  // SIGUSR2 default disposition is "terminate" on POSIX, so the parent
  // MUST have its own SIGUSR2 handler installed — tui-reexec-signals.ts
  // arms one BEFORE Bun.spawn returns, so by the time this code runs
  // (necessarily after spawn) the handler is guaranteed to be present.
  try {
    if (typeof process.ppid === "number" && process.ppid > 0) {
      process.kill(process.ppid, "SIGUSR2");
    }
  } catch {
    // Parent already gone or doesn't accept SIGUSR2 — ignore; the parent
    // falls back to its 500ms delayed-replay heuristic.
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
    // Arm signal handlers BEFORE spawning the child to eliminate the
    // spawn-to-handler race window (#1750). The two-phase API installs
    // SIGTERM/SIGHUP handlers immediately, then binds the child ref
    // after spawn. If a signal arrives before spawn, `terminated` is
    // true and we skip spawning entirely.
    const { armTuiReexecSignalHandlers } = await import("./tui-reexec-signals.js");
    const guard = armTuiReexecSignalHandlers();
    // Yield to the event loop so any signals queued during the
    // synchronous arm phase can fire their handlers and set
    // pendingSignal before we check terminated.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (guard.terminated) {
      process.exit(guard.terminatedExitCode);
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
    // Re-check terminated AFTER spawn but BEFORE bind (#1906 R8/R9): a
    // SIGUSR1 landing between the pre-spawn check and this point would
    // otherwise let the child start the TUI bootstrap and hit the exact
    // runtime-init race the pre-spawn-abort was meant to avoid. SIGKILL
    // the newborn child synchronously — nothing to tear down gracefully.
    //
    // SIGUSR1 only: SIGTERM/SIGHUP MUST flow through bindChild →
    // forwardToChild so the graceful SIGTERM-with-SIGKILL-escalation
    // path runs; skipping it would turn an ordinary supervisor shutdown
    // into an abrupt kill.
    if (guard.terminated && guard.shouldKillNewbornChild) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Child may already be exiting.
      }
      process.exit(guard.terminatedExitCode);
    }
    guard.bindChild(proc);
    const childExit = await proc.exited;
    // If the parent handled a SIGHUP, preserve that exit code instead
    // of the child's SIGTERM exit (143). Supervisors need to distinguish
    // terminal hangup (129) from operator kill (143).
    process.exit(guard.terminated ? guard.terminatedExitCode : childExit);
    break;
  }
  case "tui": {
    // Early SIGUSR1 handler is already armed at the top of this file
    // for the browser-build child (#1906). runTuiCommand swaps it for
    // the full graceful-shutdown handler during bootstrap.
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
