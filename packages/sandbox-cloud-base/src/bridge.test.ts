import { describe, expect, mock, test } from "bun:test";
import type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createCachedBridge } from "./bridge.js";
import { createTestProfile } from "./test-profiles.js";

function createMockResult(overrides?: Partial<SandboxAdapterResult>): SandboxAdapterResult {
  return {
    exitCode: 0,
    stdout: '{"result": 42}',
    stderr: "",
    durationMs: 100,
    timedOut: false,
    oomKilled: false,
    ...overrides,
  };
}

function createMockInstance(resultFn?: () => Promise<SandboxAdapterResult>): SandboxInstance {
  const execFn = resultFn ?? (() => Promise.resolve(createMockResult()));
  return {
    exec: mock(execFn as SandboxInstance["exec"]),
    readFile: mock(() => Promise.resolve(new Uint8Array())),
    writeFile: mock(() => Promise.resolve()),
    destroy: mock(() => Promise.resolve()),
  };
}

function createMockAdapter(instance: SandboxInstance): SandboxAdapter {
  return {
    name: "mock",
    create: mock(() => Promise.resolve(instance)),
  };
}

describe("createCachedBridge", () => {
  const profile: SandboxProfile = createTestProfile("sandbox");

  test("executes code and returns parsed JSON output", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("echo 42", {}, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ result: 42 });
    }

    await bridge.dispose();
  });

  test("returns raw stdout when JSON parse fails", async () => {
    const instance = createMockInstance(() =>
      Promise.resolve(createMockResult({ stdout: "plain text" })),
    );
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("echo hello", {}, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("plain text");
    }

    await bridge.dispose();
  });

  test("returns TIMEOUT error when process times out", async () => {
    const instance = createMockInstance(() =>
      Promise.resolve(createMockResult({ timedOut: true })),
    );
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("sleep 100", {}, 1000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }

    await bridge.dispose();
  });

  test("returns OOM error when process is OOM killed", async () => {
    const instance = createMockInstance(() =>
      Promise.resolve(createMockResult({ oomKilled: true })),
    );
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("alloc-all-mem", {}, 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OOM");
    }

    await bridge.dispose();
  });

  test("returns CRASH error on non-zero exit code", async () => {
    const instance = createMockInstance(() =>
      Promise.resolve(createMockResult({ exitCode: 1, stderr: "error occurred" })),
    );
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("fail", {}, 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("error occurred");
    }

    await bridge.dispose();
  });

  test("reuses instance across multiple executions", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.execute("cmd1", {}, 5000);
    await bridge.execute("cmd2", {}, 5000);

    // Adapter.create should only be called once
    expect(adapter.create).toHaveBeenCalledTimes(1);

    await bridge.dispose();
  });

  test("dispose destroys the instance", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.execute("cmd", {}, 5000);
    await bridge.dispose();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  test("execute after dispose throws", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.dispose();

    const result = await bridge.execute("cmd", {}, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("disposed");
    }
  });

  test("catches errors from adapter.create", async () => {
    const adapter: SandboxAdapter = {
      name: "failing",
      create: mock(() => Promise.reject(new Error("creation failed"))),
    };
    const bridge = createCachedBridge({ adapter, profile });

    const result = await bridge.execute("cmd", {}, 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toContain("creation failed");
    }

    await bridge.dispose();
  });
});
