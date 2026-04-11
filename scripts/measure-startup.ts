#!/usr/bin/env bun
/**
 * Startup latency CI gate (#1637).
 *
 * Measures **warmed/steady-state** startup latency of the koi CLI
 * across two scenarios. "Warmed" is deliberate: we do 3 untimed warmup
 * spawns per scenario before taking timed samples so Bun's module
 * cache, the OS filesystem cache, and any JIT state are primed. This
 * gives stable p50/p90 numbers but does NOT measure "first launch
 * after a fresh install" cost — that would require per-sample cache
 * isolation we don't have today. See docs/contributing/perf-budgets.md
 * for the honest scope statement. The gate's primary value is catching
 * *incremental* regressions (PR → PR) against a committed baseline, not
 * absolute cold-start budgets.
 *
 * Scenarios:
 *   1. fast-path         — `koi --version` (pre-import fast path in bin.ts)
 *   2. command-dispatch  — `KOI_STARTUP_PROBE=1 koi sessions list` — forces
 *      all lazy imports (args.js, registry.js, command loader) and exits
 *      before the command body runs, via the probe hook in bin.ts
 *
 * Gate logic (per scenario):
 *   1. stats.p50 <= scenario.budgetMs                                  (hard ceiling)
 *   2. stats.p50 <= max(baseline.p50 + absSlop, baseline.p50 * 1.20)   (median drift)
 *   3. stats.p90 <= max(baseline.p90 + absSlop, baseline.p90 * 1.25)   (tail drift)
 *
 * Usage:
 *   bun scripts/measure-startup.ts                   # measure + gate (CI)
 *   bun scripts/measure-startup.ts --local           # gate only vs hard budget
 *   bun scripts/measure-startup.ts --update-baseline # refresh baseline (CI only)
 *   bun scripts/measure-startup.ts --json            # machine-readable output
 *   bun scripts/measure-startup.ts --samples 30      # override sample count
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly budgetMs: number;
  readonly absSlopMs: number;
}

export interface Stats {
  readonly p50: number;
  readonly p90: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly samples: number;
}

export interface Environment {
  readonly runner: string;
  readonly bun: string;
  readonly arch: string;
}

export interface BaselineScenario {
  readonly p50: number;
  readonly p90: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly samples: number;
}

export interface Baseline {
  readonly generatedAt: string;
  readonly environment: Environment;
  readonly scenarios: Readonly<Record<string, BaselineScenario>>;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly stats: Stats;
}

export interface Violation {
  readonly scenario: string;
  readonly rule: string;
  readonly actual: number;
  readonly limit: number;
  readonly message: string;
}

export interface CompareResult {
  readonly pass: boolean;
  readonly violations: readonly Violation[];
}

// ── Constants ───────────────────────────────────────────────────────────────

// ROOT defaults to the directory above this script file, but can be
// overridden by --repo-root when the script is executed from outside
// the repo (e.g. from $RUNNER_TEMP in CI, where import.meta.url no
// longer points into the repo). All downstream paths are derived at
// main() time from the resolved repo root, not from this constant.
const DEFAULT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export const DEFAULT_WARMUPS = 3;
export const DEFAULT_SAMPLES = 20;
export const P50_PCT_TOLERANCE = 1.2;
export const P90_PCT_TOLERANCE = 1.25;

/**
 * Two scenarios are measured in different ways:
 *
 * - `fast-path` invokes the shipped binary (`dist/bin.js --version`). This
 *   is what users actually pay when they run `koi --version` and is
 *   guarded end-to-end including Bun spawn + bin.ts top-of-file code.
 *
 * - `command-dispatch` invokes the **non-shipped** benchmark harness at
 *   `packages/meta/cli/scripts/bench-entry.ts` which mirrors bin.ts's
 *   dynamic-import sequence (args.ts → registry.ts → start loader with
 *   @koi/channel-cli, @koi/core, @koi/engine, @koi/harness) and exits 0.
 *   This exists so the production bin.ts can remain free of any probe,
 *   flag, or bypass. `scripts/` is not in the CLI package's published
 *   `files` list, so the harness never ships to users.
 *
 * If `bin.ts` ever gains another dynamic-import step on the command
 * dispatch path, update `bench-entry.ts` to match.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: "fast-path",
    description: "koi --version (pre-import fast path)",
    argv: ["--version"],
    env: {},
    budgetMs: 250,
    absSlopMs: 50,
  },
  {
    name: "command-dispatch",
    description: "bench-entry harness (args + registry + start loader)",
    argv: ["__BENCH_ENTRY__"], // sentinel — replaced with BENCH_ENTRY path in measureOnce
    env: {},
    budgetMs: 2000,
    absSlopMs: 200,
  },
];

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function computeStats(samples: readonly number[]): Stats {
  if (samples.length === 0) {
    throw new Error("computeStats: empty samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (p: number): number => {
    // Nearest-rank percentile — simple, consistent, works for small n
    const idx = Math.min(n - 1, Math.ceil((p / 100) * n) - 1);
    // biome-ignore lint/style/noNonNullAssertion: idx is bounded to [0, n-1]
    return sorted[Math.max(0, idx)]!;
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: pick(50),
    p90: pick(90),
    mean: sum / n,
    // biome-ignore lint/style/noNonNullAssertion: n >= 1
    min: sorted[0]!,
    // biome-ignore lint/style/noNonNullAssertion: n >= 1
    max: sorted[n - 1]!,
    samples: n,
  };
}

export function compareAgainst(
  scenarioName: string,
  stats: Stats,
  baseline: BaselineScenario | undefined,
  scenario: Scenario,
): CompareResult {
  const violations: Violation[] = [];

  // 1. Hard ceiling — applies always, baseline or no baseline
  if (stats.p50 > scenario.budgetMs) {
    violations.push({
      scenario: scenarioName,
      rule: "hard-ceiling (p50)",
      actual: stats.p50,
      limit: scenario.budgetMs,
      message: `p50 ${stats.p50.toFixed(1)}ms exceeds hard budget ${scenario.budgetMs}ms`,
    });
  }

  // 2/3. Drift gates — only if baseline is present
  if (baseline !== undefined) {
    const p50Limit = Math.max(baseline.p50 + scenario.absSlopMs, baseline.p50 * P50_PCT_TOLERANCE);
    if (stats.p50 > p50Limit) {
      violations.push({
        scenario: scenarioName,
        rule: "drift (p50)",
        actual: stats.p50,
        limit: p50Limit,
        message: `p50 ${stats.p50.toFixed(1)}ms exceeds drift limit ${p50Limit.toFixed(1)}ms (baseline ${baseline.p50.toFixed(1)}ms)`,
      });
    }

    const p90Limit = Math.max(baseline.p90 + scenario.absSlopMs, baseline.p90 * P90_PCT_TOLERANCE);
    if (stats.p90 > p90Limit) {
      violations.push({
        scenario: scenarioName,
        rule: "drift (p90)",
        actual: stats.p90,
        limit: p90Limit,
        message: `p90 ${stats.p90.toFixed(1)}ms exceeds drift limit ${p90Limit.toFixed(1)}ms (baseline ${baseline.p90.toFixed(1)}ms)`,
      });
    }
  }

  return { pass: violations.length === 0, violations };
}

export function detectEnvironment(env: Readonly<Record<string, string | undefined>>): Environment {
  const isCi = env.GITHUB_ACTIONS === "true";
  const runner = isCi
    ? `github-actions/${env.RUNNER_OS ?? "unknown"}/${env.RUNNER_ARCH ?? "unknown"}`
    : "local";
  return {
    runner,
    bun: typeof Bun === "undefined" ? "unknown" : Bun.version,
    arch: process.arch,
  };
}

export function environmentMatches(a: Environment, b: Environment): boolean {
  return a.runner === b.runner && a.bun === b.bun && a.arch === b.arch;
}

/**
 * Verify that every scenario in SCENARIOS has a corresponding baseline
 * entry with the required stat fields. A partial/stale baseline (e.g. a
 * scenario was renamed or added, but the baseline wasn't refreshed)
 * would silently make `useBaseline?.scenarios[name]` return `undefined`
 * and let the gate fall back to hard-ceiling-only, which is the exact
 * silent-degradation failure mode the gate is meant to prevent.
 * Returns an array of human-readable error messages; empty = OK.
 */
export function validateBaselineSchema(
  baseline: Baseline,
  scenarios: readonly Scenario[],
): readonly string[] {
  const errors: string[] = [];
  const expectedNames = new Set(scenarios.map((s) => s.name));
  const actualNames = new Set(Object.keys(baseline.scenarios));

  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      errors.push(`missing baseline entry for scenario "${name}"`);
      continue;
    }
    const entry = baseline.scenarios[name];
    if (entry === undefined) {
      errors.push(`baseline entry for "${name}" is undefined`);
      continue;
    }
    for (const field of ["p50", "p90", "mean", "min", "max", "samples"] as const) {
      const v = entry[field];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`baseline entry "${name}".${field} is not a finite number (got ${String(v)})`);
      }
    }
  }

  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      errors.push(
        `baseline contains unknown scenario "${name}" (not in current SCENARIOS); refresh the baseline`,
      );
    }
  }

  return errors;
}

export function formatReport(
  results: readonly ScenarioResult[],
  baseline: Baseline | undefined,
  env: Environment,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("── Startup latency report ─────────────────────────────");
  lines.push(`environment : ${env.runner}  bun=${env.bun}  arch=${env.arch}`);
  if (baseline !== undefined) {
    lines.push(`baseline    : ${baseline.generatedAt}  (${baseline.environment.runner})`);
  } else {
    lines.push("baseline    : (none — hard-budget only)");
  }
  lines.push("");
  lines.push("scenario          |   p50   |   p90   |  mean   |  min    |  max");
  lines.push("──────────────────┼─────────┼─────────┼─────────┼─────────┼────────");
  for (const { scenario, stats } of results) {
    lines.push(
      `${scenario.name.padEnd(18)}| ${fmt(stats.p50)} | ${fmt(stats.p90)} | ${fmt(stats.mean)} | ${fmt(stats.min)} | ${fmt(stats.max)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(ms: number): string {
  return `${ms.toFixed(1).padStart(6)}ms`;
}

// ── Measurement (impure, not tested in unit tests) ──────────────────────────

function scenarioCmd(
  scenario: Scenario,
  bunBinary: string,
  cliBin: string,
  benchEntry: string,
): readonly string[] {
  // The command-dispatch scenario spawns the bench-entry harness
  // directly via Bun rather than going through dist/bin.js — this is
  // how we avoid adding any probe/flag/bypass to the shipped bin.ts.
  if (scenario.argv[0] === "__BENCH_ENTRY__") {
    return [bunBinary, benchEntry];
  }
  return [bunBinary, cliBin, ...scenario.argv];
}

/**
 * Allowlist of environment variables forwarded to benchmark child
 * processes when --scrub-env is set. Everything else (including
 * anything PR-controlled build steps appended to $GITHUB_ENV) is
 * dropped. The scrubbed environment is deterministic and minimal,
 * which is also better for measurement reproducibility.
 *
 * Notably: HOME is NOT in this list. PR-controlled bun install /
 * bun run build can write into the job's HOME (e.g. ~/.bunfig.toml,
 * ~/.bun/* state, ~/.config/*) and those files would otherwise be
 * consulted by the benchmark subprocess — a way to steer the
 * measured process even with a hash-verified bun binary and script.
 * buildChildEnv below overrides HOME and XDG_* to a freshly-created
 * empty directory the PR cannot have preseeded.
 *
 * If a future scenario needs a new env var, add it here deliberately.
 */
const SCRUBBED_ENV_ALLOWLIST: readonly string[] = [
  "PATH", // process lookup (bunBinary is absolute, but Bun still resolves children via PATH)
  "USER", // some tools probe this
  "LANG", // locale
  "LC_ALL", // locale
  "LC_CTYPE", // locale
  "TZ", // timezone
  "TERM", // tty detection
  "TMPDIR", // tmp lookups
  "SHELL", // tty detection
];

function buildChildEnv(
  scenario: Scenario,
  scrub: boolean,
  sterileHome: string,
): Readonly<Record<string, string>> {
  if (!scrub) {
    return { ...process.env, ...scenario.env } as Record<string, string>;
  }
  const env: Record<string, string> = {};
  for (const key of SCRUBBED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  // Override HOME and XDG_* lookups so PR-preseeded config (e.g.
  // ~/.bunfig.toml, ~/.bun/*, ~/.config/*) is not discoverable by
  // the benchmark subprocess.
  env.HOME = sterileHome;
  env.XDG_CONFIG_HOME = `${sterileHome}/.config`;
  env.XDG_CACHE_HOME = `${sterileHome}/.cache`;
  env.XDG_DATA_HOME = `${sterileHome}/.local/share`;
  env.XDG_STATE_HOME = `${sterileHome}/.local/state`;
  for (const [key, value] of Object.entries(scenario.env)) {
    env[key] = value;
  }
  return env;
}

function measureOnce(
  scenario: Scenario,
  bunBinary: string,
  cliBin: string,
  benchEntry: string,
  scrubEnv: boolean,
  sterileHome: string,
): number {
  const start = performance.now();
  const result = Bun.spawnSync({
    cmd: scenarioCmd(scenario, bunBinary, cliBin, benchEntry),
    env: buildChildEnv(scenario, scrubEnv, sterileHome),
    stdout: "ignore",
    stderr: "pipe",
  });
  const elapsed = performance.now() - start;
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
    throw new Error(
      `scenario ${scenario.name} exited with code ${String(result.exitCode)}:\n${stderr}`,
    );
  }
  return elapsed;
}

function measureScenario(
  scenario: Scenario,
  opts: {
    readonly warmups: number;
    readonly samples: number;
    readonly bunBinary: string;
    readonly cliBin: string;
    readonly benchEntry: string;
    readonly scrubEnv: boolean;
    readonly sterileHome: string;
  },
): Stats {
  for (let i = 0; i < opts.warmups; i++) {
    measureOnce(
      scenario,
      opts.bunBinary,
      opts.cliBin,
      opts.benchEntry,
      opts.scrubEnv,
      opts.sterileHome,
    );
  }
  const timings: number[] = [];
  for (let i = 0; i < opts.samples; i++) {
    timings.push(
      measureOnce(
        scenario,
        opts.bunBinary,
        opts.cliBin,
        opts.benchEntry,
        opts.scrubEnv,
        opts.sterileHome,
      ),
    );
  }
  return computeStats(timings);
}

// ── I/O (impure) ────────────────────────────────────────────────────────────

async function loadBaseline(path: string): Promise<Baseline | undefined> {
  const f = Bun.file(path);
  if (!(await f.exists())) return undefined;
  return (await f.json()) as Baseline;
}

/**
 * Load the baseline from a specific git ref (typically `main`) rather
 * than the working tree. This is the gate's defense against a PR
 * inflating its own `bench/startup-baseline.json` to paper over a
 * regression in the same diff: in CI gate mode, we compare against
 * main's committed baseline regardless of what the PR branch contains.
 *
 * Returns `undefined` when the file does not exist on `ref` (e.g.
 * the very first PR that introduces the gate), so the caller can
 * decide how to handle the bootstrap case.
 */
/**
 * Check whether a git ref has a committed bench/startup-baseline.json
 * without actually reading it. Used to distinguish "genuine bootstrap"
 * (no baseline anywhere) from "stale branch" (ref lacks baseline but
 * main tip has one).
 *
 * Discriminates between:
 *   exit 0                              → path exists at ref → returns true
 *   exit 128 + "does not exist" stderr  → clean absence → returns false
 *   exit 128 + "unknown revision"       → bad ref → throws with guidance
 *   anything else                       → unexpected git error → throws
 *
 * Note: `git cat-file -e` returns 128 for missing paths (with
 * "fatal: path '...' does not exist in '...'"), not 1 as earlier
 * drafts of this helper assumed. Classifying only by exit code
 * would fail the bootstrap case and break rollout.
 */
export async function refHasBaselineFile(ref: string, repoRoot: string): Promise<boolean> {
  const result = Bun.spawnSync({
    cmd: ["git", "cat-file", "-e", `${ref}:bench/startup-baseline.json`],
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return true;
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
  if (/does not exist|exists on disk, but not in/i.test(stderr)) {
    // Clean absence: the path is not present in the ref's tree.
    return false;
  }
  if (/unknown revision|bad revision|not a tree object/i.test(stderr)) {
    throw new Error(
      `refHasBaselineFile(${ref}): unknown or bad revision. Is the ref fetched?\n${stderr}`,
    );
  }
  throw new Error(
    `refHasBaselineFile(${ref}): unexpected git cat-file failure (exit ${String(result.exitCode)})\n${stderr}`,
  );
}

async function loadBaselineFromRef(ref: string, repoRoot: string): Promise<Baseline | undefined> {
  const result = Bun.spawnSync({
    cmd: ["git", "show", `${ref}:bench/startup-baseline.json`],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
    // Distinguish "file doesn't exist yet" from "git broken".
    if (stderr.includes("does not exist") || stderr.includes("exists on disk, but not in")) {
      return undefined;
    }
    if (stderr.includes("unknown revision") || stderr.includes("bad revision")) {
      throw new Error(
        `cannot resolve baseline ref "${ref}" — is main fetched? try: git fetch origin main\n${stderr}`,
      );
    }
    // Anything else is unexpected.
    throw new Error(`git show ${ref}:bench/startup-baseline.json failed: ${stderr}`);
  }
  const text = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as Baseline;
  } catch (e: unknown) {
    throw new Error(`baseline at ${ref} is not valid JSON: ${String(e)}`);
  }
}

async function saveBaseline(baseline: Baseline, path: string): Promise<void> {
  // parent dir may not exist on a clean checkout or when redirected
  // to $RUNNER_TEMP — create it before writing so Bun.write does
  // not ENOENT.
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

async function saveReport(payload: unknown, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`);
}

// ── Flag parsing ────────────────────────────────────────────────────────────

interface Flags {
  readonly local: boolean;
  readonly updateBaseline: boolean;
  readonly json: boolean;
  readonly samples: number;
  readonly baselineRef: string | undefined;
  readonly allowMigration: boolean;
  // A pre-pinned main SHA captured by CI before any PR code runs.
  // The script uses this instead of the mutable symbolic
  // `origin/main` ref so PR build scripts cannot rewrite
  // refs/remotes/origin/main to subvert the stale-branch check.
  readonly mainSha: string | undefined;
  // Absolute path to the bun binary used for spawning scenarios.
  // CI captures this via `which bun` before any PR postinstall runs
  // and passes it here so Bun.spawnSync does not fall back to PATH
  // lookup (PATH is locked to system directories in the trusted
  // steps, and bun is not in /usr/bin). Local runs use "bun" from
  // PATH as before.
  readonly bunPath: string | undefined;
  // When true, benchmark child processes run with a scrubbed
  // environment (allowlist only) rather than inheriting
  // process.env wholesale. CI uses this because PR build code can
  // append arbitrary variables to $GITHUB_ENV that would otherwise
  // leak into the measured process. Local runs default to false
  // for developer convenience.
  readonly scrubEnv: boolean;
  // Absolute path to the monorepo root. When not set, defaults to
  // the directory above this script file (via import.meta.url). CI
  // sets it explicitly because the trusted script is copied to
  // $RUNNER_TEMP (outside the workspace) to prevent PR-controlled
  // background processes from tampering with the file being
  // executed. All benchmark artifact lookups (CLI_BIN, BENCH_ENTRY,
  // BASELINE_PATH, REPORT_PATH) are resolved relative to this root.
  readonly repoRoot: string | undefined;
  // Set by CI on push-to-main events when the pushed commit range
  // ADDS bench/startup-baseline.json (the bootstrap-completion
  // merge — the first merge that lands the initial baseline, or
  // a later merge that lands a migration refresh). In this case
  // the ref passed as --baseline-ref is the pre-push commit which
  // legitimately has no baseline, while main's tip does. Without
  // this signal the script would take the stale-branch hard-fail
  // path and the first post-merge main run would be red.
  //
  // When this flag is set AND the trusted ref has no baseline AND
  // main tip does have one, the script runs in hard-budget-only
  // bootstrap mode instead of failing. Drift enforcement resumes
  // on the NEXT push, when github.event.before will point at the
  // merge commit that has the baseline.
  readonly bootstrapCompletion: boolean;
  // Two-phase rollout flag (modeled on Claude Code's
  // trustedDevice.ts staged-enforcement pattern). When set, the
  // gate runs the full measurement pipeline (including drift
  // checks against a committed baseline if present), but any
  // violations produce a loud warning instead of a non-zero exit.
  // This lets the initial rollout PR land the measurement
  // infrastructure without the first green check being treated
  // as evidence that the PR-authored gate is correct. Enforcement
  // is enabled in a follow-up PR on main by removing --warn-only
  // from the workflow — a visible code diff that a reviewer can
  // audit independently of the measurement logic.
  readonly warnOnly: boolean;
  // Override the destination path for the baseline refresh write
  // and the report write. CI uses this to direct the outputs into
  // $RUNNER_TEMP so a PR-controlled background process cannot
  // rewrite the generated baseline/report in the workspace after
  // the trusted script produces it but before upload-artifact
  // reads it.
  readonly baselineOutput: string | undefined;
  readonly reportOutput: string | undefined;
}

export function parseFlags(argv: readonly string[]): Flags {
  let local = false;
  let updateBaseline = false;
  let json = false;
  let samples = DEFAULT_SAMPLES;
  let baselineRef: string | undefined;
  let allowMigration = false;
  let mainSha: string | undefined;
  let bunPath: string | undefined;
  let scrubEnv = false;
  let repoRoot: string | undefined;
  let baselineOutput: string | undefined;
  let reportOutput: string | undefined;
  let bootstrapCompletion = false;
  let warnOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") local = true;
    else if (a === "--update-baseline") updateBaseline = true;
    else if (a === "--json") json = true;
    else if (a === "--allow-migration") allowMigration = true;
    else if (a === "--samples") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--samples requires a value");
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 3) throw new Error("--samples must be an integer >= 3");
      samples = n;
      i++;
    } else if (a === "--baseline-ref") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--baseline-ref requires a value (e.g. origin/main)");
      baselineRef = next;
      i++;
    } else if (a === "--main-sha") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--main-sha requires a value (a full git SHA)");
      if (!/^[0-9a-f]{40}$/i.test(next)) {
        throw new Error(`--main-sha must be a 40-char git SHA (got ${String(next)})`);
      }
      mainSha = next;
      i++;
    } else if (a === "--bun-path") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--bun-path requires a value (an absolute path)");
      if (!next.startsWith("/"))
        throw new Error(`--bun-path must be absolute (got ${String(next)})`);
      bunPath = next;
      i++;
    } else if (a === "--scrub-env") {
      scrubEnv = true;
    } else if (a === "--repo-root") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--repo-root requires a value (an absolute path)");
      if (!next.startsWith("/"))
        throw new Error(`--repo-root must be absolute (got ${String(next)})`);
      repoRoot = next;
      i++;
    } else if (a === "--baseline-output") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--baseline-output requires a path");
      if (!next.startsWith("/")) throw new Error("--baseline-output must be absolute");
      baselineOutput = next;
      i++;
    } else if (a === "--report-output") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--report-output requires a path");
      if (!next.startsWith("/")) throw new Error("--report-output must be absolute");
      reportOutput = next;
      i++;
    } else if (a === "--bootstrap-completion") {
      bootstrapCompletion = true;
    } else if (a === "--warn-only") {
      warnOnly = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: bun scripts/measure-startup.ts [--local] [--update-baseline] [--json] [--samples N] [--baseline-ref <git-ref>] [--main-sha <sha>] [--allow-migration]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${String(a)}`);
    }
  }
  return {
    local,
    updateBaseline,
    json,
    samples,
    baselineRef,
    allowMigration,
    mainSha,
    bunPath,
    scrubEnv,
    repoRoot,
    baselineOutput,
    reportOutput,
    bootstrapCompletion,
    warnOnly,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = detectEnvironment(process.env as Readonly<Record<string, string | undefined>>);

  // Resolve repo-relative paths. When the trusted script runs from
  // outside the workspace (CI copies it to $RUNNER_TEMP), --repo-root
  // points at the checkout so we can still find the built CLI
  // artifacts. Locally, we fall back to the directory above the
  // script file.
  const ROOT = flags.repoRoot ?? DEFAULT_ROOT;
  const CLI_BIN = resolve(ROOT, "packages/meta/cli/dist/bin.js");
  const BENCH_ENTRY = resolve(ROOT, "packages/meta/cli/dist/bench-entry.js");
  const BASELINE_PATH_IN = resolve(ROOT, "bench/startup-baseline.json");
  // Output paths default to the in-repo locations but can be
  // redirected to $RUNNER_TEMP so CI can upload untamperable
  // copies from outside the PR-writable workspace.
  const BASELINE_PATH_OUT = flags.baselineOutput ?? BASELINE_PATH_IN;
  const REPORT_PATH_OUT = flags.reportOutput ?? resolve(ROOT, "bench/startup-report.json");

  // Sanity: CLI must be built
  if (!(await Bun.file(CLI_BIN).exists())) {
    process.stderr.write(`error: CLI not built at ${CLI_BIN}\n  run: bun run build\n`);
    process.exit(1);
  }

  // Update-baseline guard: refuse outside CI to prevent accidental drift
  if (flags.updateBaseline && env.runner === "local") {
    process.stderr.write(
      "error: --update-baseline is only allowed in CI (GITHUB_ACTIONS=true).\n" +
        "  Baselines must be recorded in the same environment as the gate.\n" +
        "  Refresh via: gh workflow run ci.yml -f update_baseline=true --ref <branch>\n",
    );
    process.exit(1);
  }

  // Load baseline. Two sources:
  //   --baseline-ref <git-ref>  : load from a trusted ref (e.g. the PR
  //                               base SHA). Used by CI gate mode so a
  //                               regression PR cannot inflate its own
  //                               baseline.
  //   (no flag)                 : working-tree file. Used by --local and
  //                               --update-baseline.
  //
  // If the ref-loaded baseline is schema- or environment-incompatible
  // with the current code:
  //
  //   • With --allow-migration  : emit a loud warning and fall back to
  //                               the working-tree baseline. This is
  //                               "migration mode" for legitimate
  //                               scenario renames, Bun upgrades, or
  //                               runner migrations. CI enables this
  //                               ONLY when the PR has the
  //                               `baseline-migration` label, which is
  //                               an explicit human gate.
  //   • Without --allow-migration: HARD FAIL. A regression PR cannot
  //                               silently switch to its own baseline
  //                               by bumping a scenario name or Bun
  //                               version — it needs the label, which
  //                               requires triage attention.
  //
  // Bootstrap case (no baseline at ref at all) always falls back to
  // working-tree: there is no trusted comparator to honor.
  let existing: Baseline | undefined;
  let baselineSource: "ref" | "working-tree" = "working-tree";
  // Set when we're in genuine-bootstrap mode (no baseline anywhere).
  // In this mode the script deliberately runs hard-budget-only to
  // avoid trusting the PR-authored working-tree baseline. The
  // "missing baseline in CI" hard-fail below must not fire.
  let bootstrapMode = false;
  if (flags.baselineRef !== undefined) {
    process.stderr.write(`loading baseline from git ref: ${flags.baselineRef}\n`);
    const refBaseline = await loadBaselineFromRef(flags.baselineRef, ROOT);
    if (refBaseline !== undefined) {
      const schemaErrors = validateBaselineSchema(refBaseline, SCENARIOS);
      const envMatches = environmentMatches(env, refBaseline.environment);
      if (schemaErrors.length === 0 && envMatches) {
        existing = refBaseline;
        baselineSource = "ref";
      } else if (flags.allowMigration) {
        // Label-authorized migration — fall back with loud warning.
        process.stderr.write(
          "::warning::ref baseline is incompatible with current code/env; falling back to working-tree baseline (migration mode)\n",
        );
        if (schemaErrors.length > 0) {
          process.stderr.write("  schema mismatch:\n");
          for (const err of schemaErrors) process.stderr.write(`    • ${err}\n`);
        }
        if (!envMatches) {
          process.stderr.write(
            `  env mismatch:\n` +
              `    current : runner=${env.runner} bun=${env.bun} arch=${env.arch}\n` +
              `    ref     : runner=${refBaseline.environment.runner} bun=${refBaseline.environment.bun} arch=${refBaseline.environment.arch}\n`,
          );
        }
        process.stderr.write(
          "  migration authorized by --allow-migration (CI checks the `baseline-migration` label)\n",
        );
        existing = await loadBaseline(BASELINE_PATH_IN);
        baselineSource = "working-tree";
      } else {
        // No authorization — fail closed. Do not silently fall back.
        process.stderr.write(
          "error: ref baseline is incompatible with current code/env and --allow-migration was not set\n",
        );
        if (schemaErrors.length > 0) {
          process.stderr.write("  schema mismatch:\n");
          for (const err of schemaErrors) process.stderr.write(`    • ${err}\n`);
        }
        if (!envMatches) {
          process.stderr.write(
            `  env mismatch:\n` +
              `    current : runner=${env.runner} bun=${env.bun} arch=${env.arch}\n` +
              `    ref     : runner=${refBaseline.environment.runner} bun=${refBaseline.environment.bun} arch=${refBaseline.environment.arch}\n`,
          );
        }
        process.stderr.write(
          "  if this is a legitimate scenario/schema or Bun-version migration, apply the\n" +
            "  `baseline-migration` label to the PR. CI will then pass --allow-migration and\n" +
            "  use the refreshed working-tree baseline. See docs/contributing/perf-budgets.md.\n",
        );
        process.exit(1);
      }
    } else {
      // Ref has no baseline. Two sub-cases:
      //
      //                       working-tree baseline — that file
      //                       is PR-authored and self-authored
      //                       drift is the failure mode we guard
      //                       against. Hard budgets still apply
      //                       (they come from SCENARIOS in the
      //                       trusted script).
      //   Stale branch      : the ref (e.g. merge-base) predates
      //                       the committed baseline, but main
      //                       has one. Hard-fail UNCONDITIONALLY.
      //                       Rebasing onto main is the only
      //                       correct action. Neither
      //                       --allow-migration nor the
      //                       baseline-migration label is
      //                       permitted to swap in the PR's
      //                       working-tree baseline here, because
      //                       that would let long-lived stale
      //                       branches hide regressions behind
      //                       self-authored numbers.
      //                       --allow-migration is reserved for
      //                       schema/env mismatches (earlier
      //                       branch) where the ref DOES have a
      //                       baseline but it is incompatible.
      //
      // Check the PINNED main SHA (passed by CI pre-install), not
      // the symbolic origin/main ref — PR build scripts may have
      // rewritten refs/remotes/origin/main by the time this runs.
      // Fall back to origin/main only when no --main-sha was passed
      // (local invocations, tests).
      const mainRef = flags.mainSha ?? "origin/main";
      const tipHasBaseline = await refHasBaselineFile(mainRef, ROOT);
      if (tipHasBaseline && !flags.bootstrapCompletion) {
        process.stderr.write(
          "error: trusted ref has no baseline, but origin/main does (stale branch)\n" +
            "  your branch's merge-base predates the committed baseline.\n" +
            "  rebase onto origin/main to pick up the baseline.\n" +
            "  --allow-migration / the baseline-migration label do NOT unblock this path;\n" +
            "  they are reserved for schema/environment migrations where the ref does have\n" +
            "  a baseline. See docs/contributing/perf-budgets.md.\n",
        );
        process.exit(1);
      }
      if (tipHasBaseline && flags.bootstrapCompletion) {
        // Push-to-main after a merge that lands the initial
        // baseline (or a later migration refresh). The pre-push
        // commit legitimately has no baseline but main's tip
        // does. Run hard-budget-only for this one post-merge
        // push; drift enforcement resumes on the next push.
        process.stderr.write(
          "::warning::bootstrap-completion push (pushed range adds baseline); enforcing hard budgets only\n",
        );
        existing = undefined;
        baselineSource = "working-tree";
        bootstrapMode = true;
        // Skip the rest of the block; we're done with baseline
        // resolution for this path.
        // (Fallthrough to the useBaseline assignment below.)
      } else {
        // Genuine bootstrap: no baseline at ref, no baseline on
        // main tip. Run hard-budget-only enforcement.
        process.stderr.write(
          "::warning::genuine bootstrap — no baseline anywhere; enforcing hard budgets only (no drift comparison)\n",
        );
        existing = undefined;
        baselineSource = "working-tree";
        bootstrapMode = true;
      }
    }
  } else {
    existing = await loadBaseline(BASELINE_PATH_IN);
  }
  const useBaseline = flags.local ? undefined : existing;

  // Missing-baseline in CI gate mode is a hard error, EXCEPT in
  // genuine bootstrap mode where the gate deliberately enforces
  // hard budgets only. Exemptions: --local, --update-baseline, and
  // the bootstrapMode fallback set above when no baseline exists
  // anywhere (trusted ref or origin/main tip).
  if (!flags.local && !flags.updateBaseline && !bootstrapMode && existing === undefined) {
    process.stderr.write(
      "error: no committed baseline at bench/startup-baseline.json\n" +
        "  drift detection cannot run without one.\n" +
        "  generate via: gh workflow run ci.yml -f update_baseline=true --ref <branch>\n" +
        "  then commit the produced bench/startup-baseline.json to the branch.\n",
    );
    process.exit(1);
  }

  // Schema validation: every current scenario must have a complete
  // baseline entry. A partial/stale baseline (missing scenario, renamed
  // scenario, malformed field) would otherwise silently downgrade the
  // gate to hard-ceiling-only for any unmapped scenario — exactly the
  // silent-pass failure mode we're trying to prevent. This check runs
  // on the FINAL selected baseline, so a working-tree fallback that
  // is itself broken still fails loud.
  if (!flags.local && !flags.updateBaseline && existing !== undefined) {
    const schemaErrors = validateBaselineSchema(existing, SCENARIOS);
    if (schemaErrors.length > 0) {
      process.stderr.write(
        `error: baseline (${baselineSource}) schema does not match current SCENARIOS\n`,
      );
      for (const err of schemaErrors) {
        process.stderr.write(`  • ${err}\n`);
      }
      process.stderr.write(
        "  refresh via: gh workflow run ci.yml -f update_baseline=true --ref <branch>\n",
      );
      process.exit(1);
    }
  }

  // Environment mismatch: refuse to compare against a baseline from a
  // different runner/Bun combo. The ref-load path above handles this
  // gracefully by falling back to working-tree; this catches the case
  // where the working-tree baseline itself is mis-recorded.
  if (!flags.local && existing !== undefined && !flags.updateBaseline) {
    if (!environmentMatches(env, existing.environment)) {
      process.stderr.write(
        `error: baseline (${baselineSource}) environment mismatch\n` +
          `  current : runner=${env.runner} bun=${env.bun} arch=${env.arch}\n` +
          `  baseline: runner=${existing.environment.runner} bun=${existing.environment.bun} arch=${existing.environment.arch}\n` +
          `  refresh via workflow_dispatch with update_baseline=true\n`,
      );
      process.exit(1);
    }
  }

  // Resolve bun binary for child processes. CI passes an absolute
  // path via --bun-path; local/test runs fall back to "bun" on the
  // inherited PATH.
  const bunBinary = flags.bunPath ?? "bun";

  // Prepare a sterile HOME for benchmark subprocesses so PR code
  // that wrote into ~/.bunfig.toml, ~/.bun/*, ~/.config/*, etc.
  // during bun install / bun run build cannot steer the measured
  // process. The directory is created fresh under the system
  // tmpdir and populated with empty XDG_* subdirectories.
  const sterileHome = await mkdtemp(resolve(tmpdir(), "koi-bench-home-"));
  await mkdir(resolve(sterileHome, ".config"), { recursive: true });
  await mkdir(resolve(sterileHome, ".cache"), { recursive: true });
  await mkdir(resolve(sterileHome, ".local/share"), { recursive: true });
  await mkdir(resolve(sterileHome, ".local/state"), { recursive: true });

  // Measure each scenario
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    process.stderr.write(
      `measuring ${scenario.name} (warmups=${DEFAULT_WARMUPS}, samples=${flags.samples})...\n`,
    );
    const stats = measureScenario(scenario, {
      warmups: DEFAULT_WARMUPS,
      samples: flags.samples,
      bunBinary,
      cliBin: CLI_BIN,
      benchEntry: BENCH_ENTRY,
      scrubEnv: flags.scrubEnv,
      sterileHome,
    });
    results.push({ scenario, stats });
  }

  // Report
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ environment: env, results }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(results, useBaseline, env));
  }

  // Always save machine-readable report for CI artifact upload
  await saveReport(
    {
      generatedAt: new Date().toISOString(),
      environment: env,
      results: results.map(({ scenario, stats }) => ({ scenario: scenario.name, stats })),
    },
    REPORT_PATH_OUT,
  );

  // Update-baseline path: write + exit without gating
  if (flags.updateBaseline) {
    const newBaseline: Baseline = {
      generatedAt: new Date().toISOString(),
      environment: env,
      scenarios: Object.fromEntries(results.map(({ scenario, stats }) => [scenario.name, stats])),
    };
    await saveBaseline(newBaseline, BASELINE_PATH_OUT);
    process.stderr.write(`\n✓ baseline updated: ${BASELINE_PATH_OUT}\n`);
    process.exit(0);
  }

  // Gate
  const allViolations: Violation[] = [];
  for (const { scenario, stats } of results) {
    const baselineEntry = useBaseline?.scenarios[scenario.name];
    const cmp = compareAgainst(scenario.name, stats, baselineEntry, scenario);
    allViolations.push(...cmp.violations);
  }

  if (allViolations.length > 0) {
    if (flags.warnOnly) {
      // Two-phase rollout (trustedDevice.ts pattern): report
      // violations as a GitHub Actions warning annotation but
      // exit 0. Enforcement is enabled by removing --warn-only
      // in a follow-up PR on main.
      process.stderr.write("\n::warning::startup latency gate would fail (warn-only mode):\n");
      for (const v of allViolations) {
        process.stderr.write(`::warning::  [${v.scenario}] ${v.rule}: ${v.message}\n`);
      }
      process.stderr.write(
        "\nwarn-only mode: this PR is not blocked, but the numbers indicate a regression.\n" +
          "See docs/contributing/perf-budgets.md#diagnosing-a-regression.\n",
      );
      return;
    }
    process.stderr.write("\n✗ startup latency gate failed:\n");
    for (const v of allViolations) {
      process.stderr.write(`  • [${v.scenario}] ${v.rule}: ${v.message}\n`);
    }
    process.stderr.write(
      "\nto diagnose: see docs/contributing/perf-budgets.md#diagnosing-a-regression\n",
    );
    process.exit(1);
  }

  if (flags.warnOnly) {
    process.stderr.write("\n✓ startup latency gate passed (warn-only mode)\n");
  } else {
    process.stderr.write("\n✓ startup latency gate passed\n");
  }
}

if (import.meta.main) {
  await main();
}
