import { describe, expect, test } from "bun:test";
import * as sandboxStack from "../index.js";

describe("@koi/sandbox-stack exports", () => {
  // ── Stack composition ───────────────────────────────────────────────
  test("exports createSandboxStack", () => {
    expect(typeof sandboxStack.createSandboxStack).toBe("function");
  });

  test("exports createExecuteCodeProvider", () => {
    expect(typeof sandboxStack.createExecuteCodeProvider).toBe("function");
  });

  test("exports createTimeoutGuardedExecutor", () => {
    expect(typeof sandboxStack.createTimeoutGuardedExecutor).toBe("function");
  });

  // ── Cloud dispatch ──────────────────────────────────────────────────
  test("exports createCloudSandbox", () => {
    expect(typeof sandboxStack.createCloudSandbox).toBe("function");
  });

  // ── Cloud-base utilities ────────────────────────────────────────────
  test("exports classifyCloudError", () => {
    expect(typeof sandboxStack.classifyCloudError).toBe("function");
  });

  test("exports createCachedBridge", () => {
    expect(typeof sandboxStack.createCachedBridge).toBe("function");
  });

  test("exports createCloudInstance", () => {
    expect(typeof sandboxStack.createCloudInstance).toBe("function");
  });

  // ── Adapter factories ───────────────────────────────────────────────
  test("exports createCloudflareAdapter", () => {
    expect(typeof sandboxStack.createCloudflareAdapter).toBe("function");
  });

  test("exports createDaytonaAdapter", () => {
    expect(typeof sandboxStack.createDaytonaAdapter).toBe("function");
  });

  test("exports createDockerAdapter", () => {
    expect(typeof sandboxStack.createDockerAdapter).toBe("function");
  });

  test("exports createE2bAdapter", () => {
    expect(typeof sandboxStack.createE2bAdapter).toBe("function");
  });

  test("exports createVercelAdapter", () => {
    expect(typeof sandboxStack.createVercelAdapter).toBe("function");
  });

  // ── Code executor ───────────────────────────────────────────────────
  test("exports createCodeExecutorProvider", () => {
    expect(typeof sandboxStack.createCodeExecutorProvider).toBe("function");
  });

  test("exports createExecuteScriptTool", () => {
    expect(typeof sandboxStack.createExecuteScriptTool).toBe("function");
  });

  test("exports executeScript", () => {
    expect(typeof sandboxStack.executeScript).toBe("function");
  });

  // ── Sandbox executor ────────────────────────────────────────────────
  test("exports createSubprocessExecutor", () => {
    expect(typeof sandboxStack.createSubprocessExecutor).toBe("function");
  });

  test("exports createPromotedExecutor", () => {
    expect(typeof sandboxStack.createPromotedExecutor).toBe("function");
  });

  test("exports detectSandboxPlatform", () => {
    expect(typeof sandboxStack.detectSandboxPlatform).toBe("function");
  });

  // ── Sandbox middleware ──────────────────────────────────────────────
  test("exports createSandboxMiddleware", () => {
    expect(typeof sandboxStack.createSandboxMiddleware).toBe("function");
  });

  test("exports sandboxMiddlewareDescriptor", () => {
    expect(sandboxStack.sandboxMiddlewareDescriptor).toBeDefined();
  });

  test("exports validateSandboxMiddlewareConfig", () => {
    expect(typeof sandboxStack.validateSandboxMiddlewareConfig).toBe("function");
  });

  test("exports DEFAULT_OUTPUT_LIMIT_BYTES", () => {
    expect(typeof sandboxStack.DEFAULT_OUTPUT_LIMIT_BYTES).toBe("number");
  });

  test("exports DEFAULT_TIMEOUT_GRACE_MS", () => {
    expect(typeof sandboxStack.DEFAULT_TIMEOUT_GRACE_MS).toBe("number");
  });

  // ── Exhaustive check ───────────────────────────────────────────────
  test("exports exactly the expected runtime symbols", () => {
    const exported = Object.keys(sandboxStack).sort();
    expect(exported).toEqual([
      "DEFAULT_OUTPUT_LIMIT_BYTES",
      "DEFAULT_TIMEOUT_GRACE_MS",
      "classifyCloudError",
      "createCachedBridge",
      "createCloudInstance",
      "createCloudSandbox",
      "createCloudflareAdapter",
      "createCodeExecutorProvider",
      "createDaytonaAdapter",
      "createDockerAdapter",
      "createE2bAdapter",
      "createExecuteCodeProvider",
      "createExecuteScriptTool",
      "createPromotedExecutor",
      "createSandboxMiddleware",
      "createSandboxStack",
      "createSubprocessExecutor",
      "createTimeoutGuardedExecutor",
      "createVercelAdapter",
      "detectSandboxPlatform",
      "executeScript",
      "sandboxMiddlewareDescriptor",
      "validateSandboxMiddlewareConfig",
    ]);
  });
});
