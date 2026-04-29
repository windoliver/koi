import { describe, expect, test } from "bun:test";
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
});
