import { describe, expect, test } from "bun:test";
import * as sandboxStack from "../index.js";

describe("@koi/sandbox-stack exports", () => {
  test("exports createSandboxStack", () => {
    expect(typeof sandboxStack.createSandboxStack).toBe("function");
  });

  test("exports createExecuteCodeProvider", () => {
    expect(typeof sandboxStack.createExecuteCodeProvider).toBe("function");
  });

  test("exports createTimeoutGuardedExecutor", () => {
    expect(typeof sandboxStack.createTimeoutGuardedExecutor).toBe("function");
  });

  test("exports exactly the expected functions", () => {
    const exported = Object.keys(sandboxStack).sort();
    expect(exported).toEqual([
      "createExecuteCodeProvider",
      "createSandboxStack",
      "createTimeoutGuardedExecutor",
    ]);
  });
});
