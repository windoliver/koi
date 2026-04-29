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
});
