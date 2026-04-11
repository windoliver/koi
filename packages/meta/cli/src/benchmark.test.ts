/**
 * Startup time regression gate (Decision 13-A).
 *
 * Verifies that --version and --help fast-paths complete within 150ms.
 * This prevents silent startup regressions as commands are added — the primary
 * value of lazy loading is a measurable startup guarantee, not an abstract one.
 *
 * If this test flakes due to CI machine load, raise the threshold rather than
 * removing the test. The threshold is a regression detector, not a perf target.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "bin.ts");
const STARTUP_LIMIT_MS = 150;

/**
 * Strip block comments, line comments, and string literals from
 * TypeScript source so token-presence checks only examine executable
 * code. The probe-purity and dispatch-helper tests below use this to
 * avoid false matches on tokens that legitimately appear in doc
 * comments (e.g. "parseArgs" in the "what runDispatch does" bullet
 * list inside bench-entry.ts's header).
 */
function stripCommentsAndStrings(src: string): string {
  return (
    src
      // block comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // line comments
      .replace(/\/\/.*$/gm, "")
      // template literals
      .replace(/`[^`]*`/g, "``")
      // double-quoted strings
      .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
      // single-quoted strings
      .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
  );
}

describe("CLI startup time", () => {
  test(`koi --version exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH, "--version"]);
    const elapsed = performance.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });

  test(`koi --help exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH, "--help"]);
    const elapsed = performance.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });

  test(`koi (no args) exits 0 in under ${String(STARTUP_LIMIT_MS)}ms`, () => {
    const start = performance.now();
    const result = Bun.spawnSync(["bun", "run", BIN_PATH]);
    const elapsed = performance.now() - start;

    // No args shows help and exits 0
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(STARTUP_LIMIT_MS);
  });
});

describe("startup-latency probe (#1637) — production-purity contract", () => {
  /**
   * The startup-latency CI gate (#1637) must NOT ship any probe,
   * measurement flag, or bypass hook inside the production CLI.
   * Drift between the shipped dispatch path and the benchmark is
   * prevented structurally: both `bin.ts` and `bench-entry.ts` call
   * the same exported `runDispatch()` function from
   * `./dispatch.ts`, so there is nothing to keep in sync.
   *
   * These tests lock that contract in. If a future change adds a
   * probe or splits the shared dispatch helper, the tests break.
   */

  test("bin.ts has no post-fast-path logic beyond runDispatch and result handling", async () => {
    // The command-dispatch scenario measures bench-entry.ts, which
    // calls runDispatch() directly and never executes bin.ts. That
    // means any new work added to bin.ts BETWEEN the raw-argv
    // fast-path and the runDispatch call is invisible to the gate.
    // A regression PR could add expensive imports or validation
    // there and ship a slower koi unchallenged.
    //
    // Defend structurally: assert that bin.ts's post-fast-path
    // executable code is limited to the runDispatch dynamic import,
    // the function call, and the switch over its DispatchResult.
    // Any new identifier on the post-fast-path side needs to be
    // added here deliberately, which forces a code review
    // checkpoint for anyone changing bin.ts's startup footprint.
    const binRaw = await Bun.file(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "bin.ts"),
    ).text();
    const binCode = stripCommentsAndStrings(binRaw);

    // Split bin.ts at the runDispatch import — everything after
    // that is "post-fast-path" and must only contain whitelisted
    // tokens. Everything before is the fast-path prologue which
    // this test doesn't police (it has its own tests above).
    const splitToken = "runDispatch";
    const splitIdx = binCode.indexOf(splitToken);
    expect(splitIdx, "bin.ts must contain runDispatch").toBeGreaterThan(-1);
    const postFastPath = binCode.slice(splitIdx);

    // Tokens that legitimately appear in the post-fast-path region.
    // If you add a new token here, you are widening the gate's
    // blind spot — make sure the added work is also covered by a
    // measurement scenario.
    const allowed = new Set([
      "runDispatch",
      "HELP",
      "VERSION",
      "rawArgv",
      "result",
      "kind",
      "exit",
      "tui",
      "reexec", // "tui-reexec"
      "run",
      "code",
      "stdout",
      "stderr",
      "process",
      "write",
      "flags",
      "mod",
      "exitCode",
      "Bun",
      "spawn",
      "execPath",
      "argv",
      "inherit",
      "env",
      "Object",
      "entries",
      "proc",
      "exited",
      "runTuiCommand",
      "await",
      "import",
      "baseEnv",
      "Record",
      "string",
      "number",
      "let",
      "const",
      "switch",
      "case",
      "break",
      "if",
      "for",
      "of",
      "typeof",
      "undefined",
      "k",
      "v",
      // TUI re-exec branch (see bin.ts case "tui-reexec")
      "slice", // process.argv.slice(1)
      "stdin", // Bun.spawn stdio options
      "KOI_TUI_BROWSER_SOLID", // env marker preventing re-exec loop
      // Signal handling helper (see tui-reexec-signals.ts, issue #1653).
      // Lazily imported — not on any measured startup path; the
      // command-dispatch benchmark scenario short-circuits before
      // tui-reexec is ever taken.
      "installTuiReexecSignalHandlers",
    ]);

    // Extract identifiers from the post-fast-path region. Simple
    // word split — false positives here are fine because the test
    // only fires on truly novel tokens.
    const identifiers = postFastPath.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const novel = [...new Set(identifiers)].filter((id) => !allowed.has(id));
    expect(
      novel,
      `bin.ts post-fast-path contains new identifiers: ${novel.join(", ")}. ` +
        "Any work added after runDispatch affects user startup but is NOT measured by the " +
        "command-dispatch scenario (which uses bench-entry.ts). If you legitimately need " +
        "this code, add the identifiers to the allowed set AND extend bench-entry.ts to " +
        "cover the new work.",
    ).toEqual([]);
  });

  test("bin.ts contains no probe, measurement flag, or env-var hook", async () => {
    const binRaw = await Bun.file(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "bin.ts"),
    ).text();
    const binCode = stripCommentsAndStrings(binRaw);
    // No environment-variable-based probes (earlier design, rejected).
    expect(binCode).not.toContain("KOI_STARTUP_PROBE");
    // No hidden CLI flags that bypass command execution.
    expect(binCode).not.toContain("__startup-probe");
    expect(binCode).not.toContain("__probe");
    // No executable reference to the bench entrypoint — bin.ts must
    // not import, spawn, or branch on bench-entry.ts. Doc comments
    // mentioning it are fine (and expected).
    expect(binCode).not.toContain("bench-entry");
    expect(binCode).not.toContain("bench_entry");
  });

  test("package.json excludes dist/bench-entry from published files", async () => {
    const pkg = (await Bun.file(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "../package.json"),
    ).json()) as { files?: readonly string[] };
    const files = pkg.files ?? [];
    expect(files.some((f) => f.includes("!dist/bench-entry.js"))).toBe(true);
  });

  test("koi nosuchcommand still exits 1 with a real error message", () => {
    // This is a lightweight smoke test that dispatch + unknown-command
    // handling is intact — no probe could turn it into exit 0.
    const result = Bun.spawnSync(["bun", "run", BIN_PATH, "nosuchcommand"]);
    expect(result.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain("Unknown command");
  });

  test("bin.ts and bench-entry.ts share the dispatch helper (no duplicate logic)", async () => {
    // The benchmark's command-dispatch scenario must exercise the
    // same code path as the shipped CLI, not a hand-maintained
    // duplicate. Both files import ./dispatch.js and call
    // runDispatch() — this test proves that's structurally
    // enforced. All checks are against code with comments and
    // string literals stripped so doc-comment mentions don't
    // trigger false matches.
    const srcDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
    const binCode = stripCommentsAndStrings(await Bun.file(resolve(srcDir, "bin.ts")).text());
    const benchCode = stripCommentsAndStrings(
      await Bun.file(resolve(srcDir, "bench-entry.ts")).text(),
    );
    // Both must import the shared dispatch helper — but since string
    // literals are stripped, we check on the `import(` token
    // appearing next to a `dispatch` identifier in the stripped code.
    // Easier: re-check on raw source since the import path is a
    // legitimate string.
    const binRaw = await Bun.file(resolve(srcDir, "bin.ts")).text();
    const benchRaw = await Bun.file(resolve(srcDir, "bench-entry.ts")).text();
    expect(binRaw).toContain('"./dispatch.js"');
    expect(benchRaw).toContain('"./dispatch.js"');
    // Both must call runDispatch(). Check on stripped code so doc
    // mentions don't count.
    expect(binCode).toContain("runDispatch(");
    expect(benchCode).toContain("runDispatch(");

    // bench-entry.ts must NOT re-implement any dispatch primitives
    // directly. If these identifiers appear in *executable code*
    // (not comments), someone has bypassed the shared helper and
    // added duplicated logic. The registry and args import strings
    // are checked against the raw source since strings got stripped.
    const forbiddenIdentifiersInBench = [
      "parseArgs", // must come from dispatch.ts
      "isKnownCommand", // must come from dispatch.ts
      "isTuiFlags", // must come from dispatch.ts
      "COMMAND_LOADERS", // must come from dispatch.ts
    ];
    for (const token of forbiddenIdentifiersInBench) {
      expect(
        benchCode,
        `bench-entry.ts executable code contains "${token}" — this should be in dispatch.ts only. Do not duplicate dispatch primitives in the benchmark harness.`,
      ).not.toContain(token);
    }
    // The registry.js / args.js import paths must NOT appear in the
    // raw bench-entry source at all — those imports belong inside
    // dispatch.ts.
    expect(benchRaw).not.toContain('"./registry.js"');
    expect(benchRaw).not.toContain('"./args.js"');
  });

  test("measured-path modules contain no benchmark-only branches", async () => {
    // Every module that bench-entry.ts transitively exercises via
    // runDispatch() must behave identically whether called from
    // bin.ts (the shipped CLI) or bench-entry.ts. If a PR added a
    // branch keyed on benchmark detection (e.g. on process.argv[1],
    // an env var, or a hidden flag), the measurer would report a
    // clean budget against a cheap path while real users paid the
    // full cost.
    //
    // The guarded-files CI step already blocks unlabeled edits to
    // these files, but this test is belt-and-suspenders and catches
    // the obvious static footprints of a benchmark-only branch in
    // case a migration-labeled PR accidentally introduces one.
    // commands/start.ts is also covered even though it is NOT in
    // the guarded list — it's high-churn feature code, so we don't
    // want the label-gate overhead, but the token check is cheap.
    const srcDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
    // Discover every .ts file under args/ dynamically so new parser
    // modules are automatically covered without test maintenance.
    const argsDir = resolve(srcDir, "args");
    const argsFiles = await Array.fromAsync(
      new Bun.Glob("*.ts").scan({ cwd: argsDir, onlyFiles: true }),
    );
    const argsRelative = argsFiles.filter((f) => !f.endsWith(".test.ts")).map((f) => `args/${f}`);
    const files = ["dispatch.ts", "args.ts", ...argsRelative, "registry.ts", "commands/start.ts"];
    for (const rel of files) {
      const code = stripCommentsAndStrings(await Bun.file(resolve(srcDir, rel)).text());
      // No reference to the bench entrypoint from production code.
      expect(code, `${rel} references bench-entry`).not.toContain("bench-entry");
      expect(code, `${rel} references bench_entry`).not.toContain("bench_entry");
      // No branches on process.argv[1] that could gate on "am I
      // being called from the benchmark?". process.argv[0] is the
      // interpreter — not a useful discriminator.
      expect(code, `${rel} branches on process.argv[1]`).not.toContain("process.argv[1]");
      expect(code, `${rel} references process.argv0`).not.toContain("process.argv0");
      // No env-var backdoors.
      expect(code, `${rel} references KOI_STARTUP_PROBE`).not.toContain("KOI_STARTUP_PROBE");
      expect(code, `${rel} references __startup-probe`).not.toContain("__startup-probe");
      expect(code, `${rel} references __probe`).not.toContain("__probe");
      expect(code, `${rel} references __bench`).not.toContain("__bench");
    }
  });

  test("dispatch.ts is the single source of post-fast-path dispatch logic", async () => {
    // Sanity: the shared helper actually contains the dispatch
    // primitives, so the forbidden-in-bench check above is meaningful.
    const dispatchRaw = await Bun.file(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "dispatch.ts"),
    ).text();
    const dispatchCode = stripCommentsAndStrings(dispatchRaw);
    const requiredIdentifiers = ["parseArgs", "isKnownCommand", "isTuiFlags", "COMMAND_LOADERS"];
    for (const token of requiredIdentifiers) {
      expect(dispatchCode, `dispatch.ts missing required identifier ${token}`).toContain(token);
    }
    // Import strings checked against raw source (stripped version
    // loses them).
    expect(dispatchRaw).toContain('"./registry.js"');
    expect(dispatchRaw).toContain('"./args.js"');
  });
});
