/**
 * Doctor command tests (Decisions 11-A and 12-A):
 *
 * - Shape assertions on DiagnosticCheck output
 * - Three-tier exit codes (OK / WARNING / FAILURE) for all scenarios
 * - --json output matches JsonOutput<DiagnosticCheck[]> envelope
 * - Flag validation ordering: isSessionsFlags guard fires before any I/O
 * - runChecks runs checks in parallel (all complete; results verified)
 */

import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../args.js";
import type { DiagnosticCheck } from "../types.js";
import { ExitCode } from "../types.js";
import { formatJsonOutput, formatTextOutput, run, runChecks } from "./doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const passCheck =
  (id = "test"): (() => Promise<DiagnosticCheck>) =>
  async () => ({ id, name: id, status: "pass" as const, message: "ok" });

const warnCheck =
  (id = "test"): (() => Promise<DiagnosticCheck>) =>
  async () => ({ id, name: id, status: "warn" as const, message: "warning", fix: "fix it" });

const failCheck =
  (id = "test"): (() => Promise<DiagnosticCheck>) =>
  async () => ({ id, name: id, status: "fail" as const, message: "broken", fix: "fix it" });

// ---------------------------------------------------------------------------
// runChecks — three-tier exit codes
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  test("returns ExitCode.OK when all checks pass", async () => {
    const { exitCode, checks } = await runChecks([passCheck(), passCheck("b")]);
    expect(exitCode).toBe(ExitCode.OK);
    expect(checks).toHaveLength(2);
  });

  test("returns ExitCode.WARNING when at least one check warns", async () => {
    const { exitCode } = await runChecks([passCheck(), warnCheck()]);
    expect(exitCode).toBe(ExitCode.WARNING);
  });

  test("returns ExitCode.FAILURE when at least one check fails", async () => {
    const { exitCode } = await runChecks([passCheck(), warnCheck(), failCheck()]);
    expect(exitCode).toBe(ExitCode.FAILURE);
  });

  test("FAILURE takes precedence over WARNING", async () => {
    const { exitCode } = await runChecks([warnCheck("a"), failCheck("b"), warnCheck("c")]);
    expect(exitCode).toBe(ExitCode.FAILURE);
  });

  test("runs all checks (parallel Promise.all — all complete)", async () => {
    const completed: string[] = [];
    const makeTracked =
      (id: string): (() => Promise<DiagnosticCheck>) =>
      async () => {
        completed.push(id);
        return { id, name: id, status: "pass" as const, message: "ok" };
      };

    const { checks } = await runChecks([makeTracked("a"), makeTracked("b"), makeTracked("c")]);

    expect(checks).toHaveLength(3);
    // All three ran — ordering is non-deterministic in parallel, so sort before asserting
    expect(completed.sort()).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// DiagnosticCheck shape
// ---------------------------------------------------------------------------

describe("DiagnosticCheck shape", () => {
  test("pass check has required fields", async () => {
    const { checks } = await runChecks([passCheck("bun-version")]);
    // Use optional chaining: if check is undefined the string assertion fails, which is correct
    expect(checks).toHaveLength(1);
    expect(checks[0]?.id).toBeString();
    expect(checks[0]?.name).toBeString();
    expect(["pass", "warn", "fail"]).toContain(checks[0]?.status ?? "");
    expect(checks[0]?.message).toBeString();
  });

  test("warn check includes fix hint", async () => {
    const { checks } = await runChecks([warnCheck("koi-yaml")]);
    expect(checks[0]?.fix).toBeString();
  });

  test("fail check includes fix hint", async () => {
    const { checks } = await runChecks([failCheck("bun-version")]);
    expect(checks[0]?.fix).toBeString();
  });
});

// ---------------------------------------------------------------------------
// JSON output (Decision 7-A: JsonOutput<DiagnosticCheck[]> envelope)
// ---------------------------------------------------------------------------

describe("formatJsonOutput", () => {
  test("ok: true when exit code is OK", async () => {
    const { checks } = await runChecks([passCheck()]);
    const output = formatJsonOutput(checks, ExitCode.OK);
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(1);
  });

  test("ok: false when exit code is WARNING", async () => {
    const { checks } = await runChecks([warnCheck()]);
    const output = formatJsonOutput(checks, ExitCode.WARNING);
    expect(output.ok).toBe(false);
    expect(output.warnings).toBeDefined();
    expect((output.warnings ?? []).length).toBeGreaterThan(0);
  });

  test("ok: false when exit code is FAILURE", async () => {
    const { checks } = await runChecks([failCheck()]);
    const output = formatJsonOutput(checks, ExitCode.FAILURE);
    expect(output.ok).toBe(false);
  });

  test("JSON output is valid JSON and round-trips", async () => {
    const { checks, exitCode } = await runChecks([passCheck(), warnCheck("w")]);
    const output = formatJsonOutput(checks, exitCode);
    const serialized = JSON.stringify(output);
    const parsed = JSON.parse(serialized) as typeof output;
    expect(parsed.ok).toBe(output.ok);
    expect(parsed.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatTextOutput
// ---------------------------------------------------------------------------

describe("formatTextOutput", () => {
  test("includes check name and message", async () => {
    const { checks } = await runChecks([passCheck("bun-version")]);
    const text = formatTextOutput(checks);
    expect(text).toContain("bun-version");
    expect(text).toContain("ok");
  });

  test("includes fix hint for warn/fail checks", async () => {
    const { checks } = await runChecks([warnCheck("koi-yaml")]);
    const text = formatTextOutput(checks);
    expect(text).toContain("Fix:");
  });

  test("includes summary line", async () => {
    const { checks } = await runChecks([passCheck(), warnCheck("w")]);
    const text = formatTextOutput(checks);
    expect(text).toMatch(/\d+ passed, \d+ warnings, \d+ failures/);
  });
});

// ---------------------------------------------------------------------------
// Flag validation ordering (Decision 12-A)
// Validate-before-execute: run() returns FAILURE immediately for wrong flags,
// without performing any I/O.
// ---------------------------------------------------------------------------

describe("run — flag validation ordering", () => {
  test("returns FAILURE for non-doctor flags without I/O", async () => {
    // Spy on process.stdout.write to verify no output occurs before flag guard fires
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const flags = parseArgs(["sessions"]);
      const exitCode = await run(flags);
      expect(exitCode).toBe(ExitCode.FAILURE);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
