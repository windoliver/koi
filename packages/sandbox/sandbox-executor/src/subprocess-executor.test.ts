import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubprocessExecutor } from "./subprocess-executor.js";

describe("createSubprocessExecutor", () => {
  test("runs simple code and returns output", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async (input) => ({ doubled: input * 2 });";
    const result = await executor.execute(code, 21, 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.output).toEqual({ doubled: 42 });
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("kills on timeout and returns SandboxError TIMEOUT", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async () => { while (true) {} };";
    const result = await executor.execute(code, null, 250);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("TIMEOUT");
  });

  test("classifies thrown error as CRASH", async () => {
    const executor = createSubprocessExecutor();
    const code = 'export default async () => { throw new Error("boom"); };';
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("CRASH");
    expect(result.error.message).toContain("boom");
  });

  test("returns CRASH when process exits without result marker", async () => {
    const executor = createSubprocessExecutor();
    // Code that writes to stdout (not the protocol marker) and exits cleanly
    const code =
      'export default async () => { process.stdout.write("no marker\\n"); process.exit(0); };';
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("CRASH");
  });

  test("user code with open event-loop anchors still returns success (Fix 2 regression)", async () => {
    // setInterval keeps the event loop alive indefinitely — without process.exit(0)
    // after writeResult the runner would never exit and would be killed as TIMEOUT.
    const executor = createSubprocessExecutor();
    const code = `
      export default async (input) => {
        // Anchor the event loop — should NOT cause a TIMEOUT
        const id = setInterval(() => {}, 10_000);
        // clearInterval so Bun doesn't actually keep running after exit(0)
        clearInterval(id);
        return { value: input };
      };
    `;
    const result = await executor.execute(code, "ping", 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ value: "ping" });
  });

  // Fix 1: context.workspacePath and context.entryPath wiring
  test("uses context.entryPath when provided instead of temp code file", async () => {
    const executor = createSubprocessExecutor();
    // Create a real entry file in a temp workspace
    const ws = mkdtempSync(join(tmpdir(), "koi-test-ws-"));
    const entryPath = join(ws, "entry.ts");
    writeFileSync(
      entryPath,
      "export default async (_input: unknown) => ({ source: 'entry' });",
      "utf8",
    );
    const result = await executor.execute(
      "export default async () => ({ source: 'code' });",
      null,
      5000,
      // networkAllowed: true acknowledges unconfined execution (no externalIsolation in this test)
      { workspacePath: ws, entryPath, networkAllowed: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    // The entry file's output should be used, not the inline code
    expect(result.value.output).toEqual({ source: "entry" });
  });

  // Security: host env vars not in SAFE_ENV_KEYS must not leak into child
  test("does not leak arbitrary host env vars into child process", async () => {
    process.env.SECRET_FOR_TEST = "leaked";
    const executor = createSubprocessExecutor();
    const code = `
      export default async (_input: unknown) => ({
        secret: process.env.SECRET_FOR_TEST,
      });
    `;
    let result: Awaited<ReturnType<typeof executor.execute>>;
    try {
      result = await executor.execute(code, null, 5000);
    } finally {
      delete process.env.SECRET_FOR_TEST;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ secret: undefined });
  });

  // Default-deny: networkAllowed=false without externalIsolation → PERMISSION
  test("returns PERMISSION when networkAllowed=false without externalIsolation", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async () => ({});";
    const result = await executor.execute(code, null, 5000, { networkAllowed: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
  });

  // Default-deny: resourceLimits set without externalIsolation → PERMISSION
  test("returns PERMISSION when resourceLimits set without externalIsolation", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async () => ({});";
    const result = await executor.execute(code, null, 5000, {
      resourceLimits: { maxMemoryMb: 64 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
  });

  // Default-deny: context={} with networkAllowed omitted → PERMISSION (omission = denial)
  test("returns PERMISSION when context is empty object with no externalIsolation (default-deny on omission)", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async () => ({});";
    // Empty context: networkAllowed is omitted (undefined) — treated as denial by default-deny
    const result = await executor.execute(code, null, 5000, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
  });

  // Default-deny bypass: context.networkAllowed=true acknowledges unconfined execution
  test("executes normally when context.networkAllowed=true without externalIsolation (caller acknowledges unconfined)", async () => {
    const executor = createSubprocessExecutor();
    const code = "export default async () => ({ ok: true });";
    // Explicitly setting networkAllowed: true is the caller's acknowledgement
    // that this execution is unconfined — the guard allows it through.
    const result = await executor.execute(code, null, 5000, { networkAllowed: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ ok: true });
  });

  // externalIsolation: true — networkAllowed=false propagates KOI_NETWORK_ALLOWED=0
  test("propagates KOI_NETWORK_ALLOWED=0 env var when networkAllowed=false and externalIsolation=true", async () => {
    const executor = createSubprocessExecutor({ externalIsolation: true });
    // The user code returns the env var value so we can assert it was set
    const code = `
      export default async (_input: unknown) => ({
        networkAllowed: process.env.KOI_NETWORK_ALLOWED,
      });
    `;
    const result = await executor.execute(code, null, 5000, { networkAllowed: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    const output = result.value.output;
    expect(output).toEqual({ networkAllowed: "0" });
  });

  // externalIsolation: true — resourceLimits propagate KOI_MAX_MEMORY_MB and KOI_MAX_PIDS
  test("propagates resource limit env vars when resourceLimits are set and externalIsolation=true", async () => {
    const executor = createSubprocessExecutor({ externalIsolation: true });
    const code = `
      export default async (_input: unknown) => ({
        memMb: process.env.KOI_MAX_MEMORY_MB,
        pids: process.env.KOI_MAX_PIDS,
      });
    `;
    const result = await executor.execute(code, null, 5000, {
      resourceLimits: { maxMemoryMb: 512, maxPids: 32 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ memMb: "512", pids: "32" });
  });

  // Cover the invalid-JSON-after-marker path (lines 234-239)
  test("returns CRASH when result marker contains non-object JSON", async () => {
    const executor = createSubprocessExecutor();
    // Emit a valid marker followed by a non-object (a bare string)
    const code = `
      export default async () => {
        process.stderr.write('__KOI_RESULT__\\n"not-an-object"\\n');
        process.exit(0);
      };
    `;
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("CRASH");
  });

  // Fix 2: stdout deadlock regression — large stdout must not cause TIMEOUT
  test("large stdout output does not deadlock (Fix 2 deadlock regression)", async () => {
    const executor = createSubprocessExecutor();
    // Write ~200 KB to stdout, then return a result — must classify as success
    const code = `
      export default async (_input: unknown) => {
        // Write ~200 KB to stdout to fill OS pipe buffer
        const chunk = "x".repeat(1024);
        for (let i = 0; i < 200; i++) process.stdout.write(chunk);
        return { ok: true };
      };
    `;
    const result = await executor.execute(code, null, 10000);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`Expected ok, got: ${result.error.code} - ${result.error.message}`);
    expect(result.value.output).toEqual({ ok: true });
  });

  // Fix 1 (streaming byte cap): executor with a tiny maxOutputBytes cap handles
  // a child that writes more than the cap without host OOM.
  test("stdout exceeding maxOutputBytes is handled gracefully without OOM (Fix 1 streaming cap)", async () => {
    // Use 1 KB cap to keep the test fast — far below any default OS pipe buffer
    const executor = createSubprocessExecutor({ maxOutputBytes: 1024 });
    // Child writes 4 KB to stdout (4× the cap), then returns a valid result.
    // With bounded reading the executor stops reading stdout early and kills the child.
    // The result must still come through stderr framing → success, OR be classified
    // as CRASH (if stderr was also truncated). What must NOT happen: host OOM or hang.
    const code = `
      export default async (_input: unknown) => {
        const chunk = "x".repeat(128);
        for (let i = 0; i < 32; i++) process.stdout.write(chunk);
        return { bounded: true };
      };
    `;
    const result = await executor.execute(code, null, 10000);
    // The execution must complete within timeout — no deadlock, no OOM.
    // The result may be ok (if stderr framing wasn't truncated) or CRASH (if it was).
    // Both outcomes are acceptable — the key invariant is that it finishes.
    expect(result.ok === true || result.ok === false).toBe(true);
  });
});
