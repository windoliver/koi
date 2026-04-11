#!/usr/bin/env bun
/**
 * Startup-latency benchmark harness (#1637).
 *
 * NOT PART OF THE SHIPPED PACKAGE. Built by tsup into
 * `dist/bench-entry.js` alongside `bin.js` (same bundling pipeline,
 * same chunks, same minification). Excluded from npm publication via
 * package.json's `files` field — users never receive this file.
 *
 * ## Why this file cannot drift from bin.ts
 *
 * Both this file and bin.ts dynamically import the same
 * `./dispatch.js` module and call the same `runDispatch()` function.
 * There is no hand-maintained duplicate of the dispatch sequence
 * anywhere. If bin.ts's post-fast-path behavior changes, this harness
 * automatically picks up the change — whatever users pay, the gate
 * measures.
 *
 * The only difference between this file and bin.ts is the final
 * step: bin.ts calls `result.mod.run(result.flags)` when dispatch
 * returns `kind: "run"`, while this file exits 0 without running.
 * That is the measurement boundary.
 *
 * ## What this measures
 *
 * For `rawArgv = ["start"]`, runDispatch performs:
 *   1. dynamic import of ./args.js
 *   2. parseArgs(rawArgv)
 *   3. flags.help / flags.version / flags.command === undefined checks
 *   4. isTuiFlags(flags) check
 *   5. isKnownCommand(flags.command) check
 *   6. dynamic import of ./registry.js
 *   7. COMMAND_LOADERS.start() — loads the start command chunk
 *      (top-level imports of @koi/channel-cli, @koi/core, @koi/engine,
 *      @koi/harness — the heaviest import graph in the CLI)
 *   8. CommandModule shape validation
 *
 * It does NOT measure any cost inside `start.ts`'s `run()` body
 * (manifest loading, hook setup, channel setup). That is a
 * documented scope limitation — see docs/contributing/perf-budgets.md.
 */

const rawArgv: readonly string[] = ["start"];

// Mirror bin.ts's raw-argv fast-path so the measurement includes the
// same no-op cost bin.ts pays before reaching dispatch. For "start"
// these never fire, but keeping them here means the measured
// prologue matches the shipped CLI.
if (rawArgv.includes("--version") || rawArgv.includes("-V")) {
  process.exit(0);
}
if (rawArgv.includes("--help") || rawArgv.includes("-h")) {
  process.exit(0);
}

// Same dynamic import path bin.ts takes post-fast-path.
const { runDispatch } = await import("./dispatch.js");

// HELP/VERSION strings are unused for "start" dispatch but the shared
// function signature requires them. Pass deterministic empty-ish
// values — their cost is constant.
const result = await runDispatch(rawArgv, "", "0.0.0");

// For the command-dispatch scenario we expect `kind: "run"` — the
// start command loader resolved and we reached the measurement
// boundary. Treat anything else as a harness error so the benchmark
// fails loud instead of silently exiting 0 with wrong data.
if (result.kind !== "run") {
  process.stderr.write(
    `bench-entry: expected dispatch result "run", got "${result.kind}" — harness contract broken\n`,
  );
  if ("stderr" in result && result.stderr !== undefined) {
    process.stderr.write(result.stderr);
  }
  process.exit(1);
}

// Intentional: do NOT call result.mod.run(result.flags). That would
// start a real service. The gate measures "how long to reach this
// point"; anything past it is out of scope. See scripts/measure-startup.ts
// and docs/contributing/perf-budgets.md for the scope statement.
process.exit(0);
