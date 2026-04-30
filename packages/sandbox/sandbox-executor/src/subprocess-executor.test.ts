import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubprocessExecutor } from "./subprocess-executor.js";

/**
 * setsid is Linux-only (not available on macOS / Windows). Tests that are not
 * specifically testing the requireProcessGroupIsolation guard must opt out so
 * they pass on all platforms. The PGI-specific tests below inject a mock
 * resolveSetsid so they are platform-agnostic.
 */
const NO_PGI = { requireProcessGroupIsolation: false } as const;

describe("createSubprocessExecutor", () => {
  test("runs simple code and returns output", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    const code = "export default async (input) => ({ doubled: input * 2 });";
    const result = await executor.execute(code, 21, 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.output).toEqual({ doubled: 42 });
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("kills on timeout and returns SandboxError TIMEOUT", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    const code = "export default async () => { while (true) {} };";
    const result = await executor.execute(code, null, 250);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("TIMEOUT");
  });

  test("classifies thrown error as CRASH", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    const code = 'export default async () => { throw new Error("boom"); };';
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("CRASH");
    expect(result.error.message).toContain("boom");
  });

  test("returns CRASH when process exits without result marker", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor(NO_PGI);
    const code = "export default async () => ({});";
    const result = await executor.execute(code, null, 5000, { networkAllowed: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
  });

  // Default-deny: resourceLimits set without externalIsolation → PERMISSION
  test("returns PERMISSION when resourceLimits set without externalIsolation", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    const code = "export default async () => ({});";
    const result = await executor.execute(code, null, 5000, {
      resourceLimits: { maxMemoryMb: 64 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
  });

  // Fix 1 (guard narrowed): context={} with networkAllowed omitted → succeeds
  // Omitting networkAllowed means "caller has no isolation opinion" — not explicit denial.
  // ExecutionContext is also used for non-isolation metadata (workspacePath, entryPath).
  test("context with no isolation fields passes through without PERMISSION (explicit-deny only)", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    const code = "export default async () => ({ ok: true });";
    // Empty context: networkAllowed is undefined (omitted) — no isolation opinion
    const result = await executor.execute(code, null, 5000, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ ok: true });
  });

  // Fix 1 (guard narrowed): context with only workspacePath/entryPath (no isolation fields) → succeeds
  test("context with only workspacePath and entryPath (no isolation fields) passes through", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    // Create a real entry file in a temp workspace
    const ws = mkdtempSync(join(tmpdir(), "koi-test-ws2-"));
    const entryPath = join(ws, "entry2.ts");
    writeFileSync(
      entryPath,
      "export default async (_input: unknown) => ({ source: 'metadata-only' });",
      "utf8",
    );
    // No networkAllowed, no resourceLimits — metadata-only context should not trigger guard
    const result = await executor.execute(
      "export default async () => ({ source: 'code' });",
      null,
      5000,
      { workspacePath: ws, entryPath },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ source: "metadata-only" });
  });

  // Default-deny bypass: context.networkAllowed=true acknowledges unconfined execution
  test("executes normally when context.networkAllowed=true without externalIsolation (caller acknowledges unconfined)", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor({
      externalIsolation: true,
      requireProcessGroupIsolation: false,
    });
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
    const executor = createSubprocessExecutor({
      externalIsolation: true,
      requireProcessGroupIsolation: false,
    });
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
    const executor = createSubprocessExecutor(NO_PGI);
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
    const executor = createSubprocessExecutor(NO_PGI);
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

  // Fix 3 (drain-not-kill): a moderately noisy stdout (50 KB) with a large cap (1 MB)
  // must succeed — the child is not killed on output cap, so it completes naturally.
  test("moderately noisy stdout (50 KB) with 1 MB cap succeeds (drain-not-kill, Fix 3)", async () => {
    const executor = createSubprocessExecutor({
      maxOutputBytes: 1024 * 1024,
      requireProcessGroupIsolation: false,
    });
    // Child writes ~50 KB to stdout, then returns a valid result.
    // Under drain-not-kill semantics the stdout is accumulated (within cap) and
    // the child completes naturally → success.
    const code = `
      export default async (_input: unknown) => {
        const chunk = "x".repeat(1024);
        for (let i = 0; i < 50; i++) process.stdout.write(chunk);
        return { bounded: true };
      };
    `;
    const result = await executor.execute(code, null, 10000);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`Expected ok, got: ${result.error.code} - ${result.error.message}`);
    expect(result.value.output).toEqual({ bounded: true });
  });

  // Fix 2 (stderr tail recovery): large stderr noise before the framing marker.
  // With a 1 MB cap, 5 MB of noise pushes the marker past the cap — must be
  // recovered from the 64 KB tail buffer rather than returning CRASH.
  test("recovers framed result from stderr tail when total stderr exceeds maxOutputBytes (Fix 2 regression)", async () => {
    // Use 1 MB cap so 5 MB of stderr noise triggers truncation.
    const executor = createSubprocessExecutor({
      maxOutputBytes: 1024 * 1024,
      requireProcessGroupIsolation: false,
    });
    const code = `
      export default async (_input: unknown) => {
        // Write 5 MB of stderr noise before the result — pushes marker past the 1 MB cap.
        const chunk = "noise".repeat(200); // ~1 KB
        for (let i = 0; i < 5000; i++) process.stderr.write(chunk);
        return { recovered: true };
      };
    `;
    const result = await executor.execute(code, null, 30000);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`Expected ok, got: ${result.error.code} - ${result.error.message}`);
    expect(result.value.output).toEqual({ recovered: true });
  });

  // Fix 3 (drain-not-kill): stdout exceeds the cap — child is not killed, it completes
  // normally. The call must finish without hanging (no blocked pipe) and without OOM.
  test("stdout exceeding cap does not kill child or hang — completes within timeout (Fix 3)", async () => {
    // Use a small cap (1 KB) so the child exceeds it quickly.
    const executor = createSubprocessExecutor({
      maxOutputBytes: 1024,
      requireProcessGroupIsolation: false,
    });
    // Child writes 50 KB stdout (50× cap), then returns a valid result via stderr framing.
    // drain-not-kill: pipe is kept drained, child exits naturally, framing is found → ok.
    const code = `
      export default async (_input: unknown) => {
        const chunk = "x".repeat(1024);
        for (let i = 0; i < 50; i++) process.stdout.write(chunk);
        return { drained: true };
      };
    `;
    const result = await executor.execute(code, null, 10000);
    // The child completes naturally; stderr framing is intact → ok.
    // (stdout is truncated, but stderr framing is unaffected since it's a separate stream)
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`Expected ok, got: ${result.error.code} - ${result.error.message}`);
    expect(result.value.output).toEqual({ drained: true });
  });

  // Fix 2 regression: child exits fast (50 ms) with large stderr (5 MB), deadline 200 ms.
  // Timer is cleared when proc.exited resolves — post-exit drain time does NOT count.
  // Must be classified as ok success, NOT TIMEOUT.
  test("child exits fast with large stderr drain — classified as success, not TIMEOUT (Fix 2 regression)", async () => {
    const executor = createSubprocessExecutor(NO_PGI);
    // Write ~5 MB to stderr, return a valid result. The child exits quickly;
    // drain takes additional time but the timer was already cleared at exit.
    const code = `
      export default async (_input: unknown) => {
        // Write 5 MB to stderr — drain happens after child exits
        const chunk = "e".repeat(1024);
        for (let i = 0; i < 5000; i++) process.stderr.write(chunk);
        return { fast: true };
      };
    `;
    const result = await executor.execute(code, null, 30000);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`Expected ok, got: ${result.error.code} - ${result.error.message}`);
    expect(result.value.output).toEqual({ fast: true });
  });

  // Fix 3 (context.env): caller-provided env vars are merged into the child env.
  // Caller-provided keys win over allowlist defaults.
  test("honors context.env by passing caller-provided env vars to child (Fix 3)", async () => {
    const executor = createSubprocessExecutor({
      externalIsolation: true,
      requireProcessGroupIsolation: false,
    });
    const code = `
      export default async (_input: unknown) => ({
        customVar: process.env.CUSTOM_VAR,
      });
    `;
    // networkAllowed: true acknowledges unconfined execution (no externalIsolation guard needed)
    const result = await executor.execute(code, null, 5000, {
      networkAllowed: true,
      env: { CUSTOM_VAR: "from-context" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ customVar: "from-context" });
  });

  // Fix 3 (requireProcessGroupIsolation): setsid unavailable → PERMISSION (fail-closed default)
  test("returns PERMISSION when setsid unavailable and requireProcessGroupIsolation defaults to true", async () => {
    // DI: inject a resolveSetsid that always returns null (simulates no setsid on PATH)
    const executor = createSubprocessExecutor({
      resolveSetsid: () => null,
    });
    const code = "export default async () => ({ ok: true });";
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("PERMISSION");
    expect(result.error.message).toContain("setsid");
  });

  // Fix 3 (requireProcessGroupIsolation): setsid unavailable + opt-out → proceeds normally
  test("proceeds when setsid unavailable but requireProcessGroupIsolation:false (opt-out)", async () => {
    // DI: inject a resolveSetsid that always returns null
    const executor = createSubprocessExecutor({
      requireProcessGroupIsolation: false,
      resolveSetsid: () => null,
    });
    const code = "export default async () => ({ ok: true });";
    const result = await executor.execute(code, null, 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error.message}`);
    expect(result.value.output).toEqual({ ok: true });
  });
});
