import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifierContext } from "../types.js";
import { createArgvGate } from "./argv-gate.js";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "koi-loop-argv-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<VerifierContext> = {}): VerifierContext {
  return {
    iteration: 1,
    workingDir: workDir,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("createArgvGate — construction", () => {
  test("rejects empty argv at construction", () => {
    expect(() =>
      createArgvGate(
        // @ts-expect-error intentional: empty tuple
        [],
      ),
    ).toThrow(/non-empty/);
  });

  test("type system forbids shell strings (compile-time)", () => {
    // @ts-expect-error shell string is not a tuple
    const _bad = createArgvGate("bun test");
    void _bad;
    // @ts-expect-error single string without tuple literal type
    const _bad2 = createArgvGate(["bun test"] as string[]);
    void _bad2;
  });
});

describe("createArgvGate — execution", () => {
  test("passes on exit 0", async () => {
    const gate = createArgvGate(["bun", "-e", "process.exit(0)"]);
    const result = await gate.check(ctx());
    expect(result.ok).toBe(true);
  });

  test("fails on exit 1 with exit code + reason", async () => {
    const gate = createArgvGate(["bun", "-e", "process.exit(1)"]);
    const result = await gate.check(ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exit_nonzero");
    expect(result.exitCode).toBe(1);
  });

  test("captures stderr in details on failure", async () => {
    const gate = createArgvGate([
      "bun",
      "-e",
      "process.stderr.write('something broke'); process.exit(2)",
    ]);
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.details).toContain("something broke");
    expect(result.exitCode).toBe(2);
  });

  test("missing binary → spawn_error", async () => {
    const gate = createArgvGate(["definitely-not-a-real-binary-xyz123"]);
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("spawn_error");
  });

  test("inner timeout → timeout reason", async () => {
    const gate = createArgvGate(["bun", "-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 });
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
  });

  test("external abort → aborted reason", async () => {
    const ctrl = new AbortController();
    const gate = createArgvGate(["bun", "-e", "setTimeout(() => {}, 5000)"]);
    const check = gate.check(ctx({ signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 30);
    const result = await check;
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("aborted");
  });

  test("respects cwd override", async () => {
    // Script prints cwd; the gate's `cwd` option should match.
    const other = await Bun.write(join(workDir, "marker.txt"), "ok");
    void other;
    const gate = createArgvGate(
      ["bun", "-e", "process.exit(require('node:fs').existsSync('marker.txt') ? 0 : 1)"],
      { cwd: workDir },
    );
    const result = await gate.check({
      iteration: 1,
      workingDir: "/tmp", // deliberately wrong; gate.cwd should override
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
  });

  test("stderr bytes cap truncates noisy output", async () => {
    const gate = createArgvGate(
      ["bun", "-e", "const s='x'.repeat(10000); process.stderr.write(s); process.exit(1)"],
      { stderrBytes: 100 },
    );
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    // stderr capture is capped to 100 bytes; further normalization by the
    // loop's 2KB truncation is separate.
    expect(result.details.length).toBeLessThanOrEqual(200);
  });

  test("regression: drains large stdout so verbose verifiers do not deadlock", async () => {
    // Emit ~256 KiB to stdout (well beyond any reasonable pipe buffer) then
    // exit 0. If stdout isn't drained, the child blocks on write() and
    // proc.exited never resolves — the gate would time out even though the
    // verifier is logically passing.
    const gate = createArgvGate(
      [
        "bun",
        "-e",
        "const buf='x'.repeat(65536); for (let i=0; i<4; i++) process.stdout.write(buf); process.exit(0)",
      ],
      { timeoutMs: 5000 },
    );
    const result = await gate.check(ctx());
    expect(result.ok).toBe(true);
  });

  test("regression: failure details do NOT echo full argv (secret-leak guard)", async () => {
    // argv carries a fake token that must never appear in details. Tests
    // three failure paths: exit-code-only, timeout, and empty streams.
    const SECRET = "sk-SUPER-SECRET-DO-NOT-LEAK-xyz";
    const gate = createArgvGate(["bun", "-e", `void "${SECRET}"; process.exit(7)`], {
      timeoutMs: 5000,
    });
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.details).not.toContain(SECRET);
  });

  test("regression: timeout details do NOT echo full argv", async () => {
    const SECRET = "sk-SUPER-SECRET-xyz";
    const gate = createArgvGate(["bun", "-e", `void "${SECRET}"; setTimeout(() => {}, 5000)`], {
      timeoutMs: 50,
    });
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
    expect(result.details).not.toContain(SECRET);
    // Executable name is fine
    expect(result.details).toContain("bun");
  });

  test("regression: default env does NOT inherit arbitrary parent secrets", async () => {
    // Round 24 fix: createArgvGate's default env is a minimal allowlist
    // (PATH, HOME, USER, LANG, etc.), not full parent-env inheritance.
    // A secret set in the parent env must NOT reach the subprocess
    // unless the caller explicitly opts in via options.env or
    // options.inheritEnv: true.
    process.env.LOOP_TEST_SECRET_XYZ = "this-should-not-leak-abc123";
    try {
      const gate = createArgvGate(
        ["bun", "-e", `process.exit(process.env.LOOP_TEST_SECRET_XYZ === undefined ? 0 : 1)`],
        { timeoutMs: 5000 },
      );
      const result = await gate.check(ctx());
      // exit 0 means the env var was NOT visible to the subprocess
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.LOOP_TEST_SECRET_XYZ;
    }
  });

  test("regression: inheritEnv: true opts back into full parent-env inheritance", async () => {
    // Legacy escape hatch for callers that explicitly need the parent
    // env — e.g. when the scrubbing is handled at a higher layer (like
    // the CLI's scrubSensitiveEnv).
    process.env.LOOP_TEST_INHERIT_XYZ = "inherited-value-456";
    try {
      const gate = createArgvGate(
        [
          "bun",
          "-e",
          `process.exit(process.env.LOOP_TEST_INHERIT_XYZ === "inherited-value-456" ? 0 : 1)`,
        ],
        { timeoutMs: 5000, inheritEnv: true },
      );
      const result = await gate.check(ctx());
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.LOOP_TEST_INHERIT_XYZ;
    }
  });

  test("default env still preserves PATH so common tools (bun) run", async () => {
    // The minimal allowlist must include PATH — otherwise real test
    // commands can't find their binaries. This is a smoke test that
    // proves the allowlist is usable for the common case.
    const gate = createArgvGate(["bun", "-e", "process.exit(0)"], { timeoutMs: 5000 });
    const result = await gate.check(ctx());
    expect(result.ok).toBe(true);
  });

  test("regression: default env includes NODE_ENV for test-runner mode detection", async () => {
    // Round 29 regression guard: test runners like bun test, vitest,
    // jest, pytest use NODE_ENV to enter test mode. Dropping it from
    // the minimal allowlist would cause them to silently run in
    // production mode and mask real failures.
    process.env.NODE_ENV = "test";
    try {
      const gate = createArgvGate(
        ["bun", "-e", `process.exit(process.env.NODE_ENV === "test" ? 0 : 1)`],
        { timeoutMs: 5000 },
      );
      const result = await gate.check(ctx());
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.NODE_ENV;
    }
  });

  test("regression: default env includes CI so test frameworks see CI mode", async () => {
    process.env.CI = "true";
    try {
      const gate = createArgvGate(
        ["bun", "-e", `process.exit(process.env.CI === "true" ? 0 : 1)`],
        { timeoutMs: 5000 },
      );
      const result = await gate.check(ctx());
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.CI;
    }
  });

  test("regression: failure with stdout but empty stderr surfaces stdout in details", async () => {
    // Some tools (bun test, pytest) write failures to stdout. The gate must
    // include stdout as a fallback when stderr is empty.
    const gate = createArgvGate(
      ["bun", "-e", "process.stdout.write('assertion failed: expected 2, got 3'); process.exit(1)"],
      { timeoutMs: 5000 },
    );
    const result = await gate.check(ctx());
    if (result.ok) throw new Error("unreachable");
    expect(result.details).toContain("assertion failed");
    expect(result.exitCode).toBe(1);
  });
});
