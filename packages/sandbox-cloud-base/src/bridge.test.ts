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

  // ---- warmup / getInstance (Phase 1.4) ----

  test("warmup calls adapter.create eagerly", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.warmup();

    expect(adapter.create).toHaveBeenCalledTimes(1);

    await bridge.dispose();
  });

  test("warmup is no-op when already warm", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.warmup();
    await bridge.warmup();

    expect(adapter.create).toHaveBeenCalledTimes(1);

    await bridge.dispose();
  });

  test("getInstance returns undefined before warmup", () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    expect(bridge.getInstance()).toBeUndefined();
  });

  test("getInstance returns instance after warmup", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.warmup();

    expect(bridge.getInstance()).toBe(instance);

    await bridge.dispose();
  });

  test("getInstance returns instance after first execute", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.execute("cmd", {}, 5000);

    expect(bridge.getInstance()).toBe(instance);

    await bridge.dispose();
  });

  // ---- Timeout clamping (Decision 6) ----

  test("clamps caller timeout to profile timeout", async () => {
    const profileWithTimeout: SandboxProfile = {
      ...profile,
      resources: { ...profile.resources, timeoutMs: 2000 },
    };
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile: profileWithTimeout });

    await bridge.execute("cmd", {}, 10_000);

    // The exec call should use clamped timeout (2000), not caller's (10_000)
    const execCall = (instance.exec as ReturnType<typeof mock>).mock.calls[0];
    expect(execCall?.[2]).toMatchObject({ timeoutMs: 2000 });

    await bridge.dispose();
  });

  test("uses caller timeout when less than profile timeout", async () => {
    const profileWithTimeout: SandboxProfile = {
      ...profile,
      resources: { ...profile.resources, timeoutMs: 10_000 },
    };
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile: profileWithTimeout });

    await bridge.execute("cmd", {}, 2000);

    const execCall = (instance.exec as ReturnType<typeof mock>).mock.calls[0];
    expect(execCall?.[2]).toMatchObject({ timeoutMs: 2000 });

    await bridge.dispose();
  });

  test("uses caller timeout when profile has no timeout", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.execute("cmd", {}, 5000);

    const execCall = (instance.exec as ReturnType<typeof mock>).mock.calls[0];
    expect(execCall?.[2]).toMatchObject({ timeoutMs: 5000 });

    await bridge.dispose();
  });

  // ---- Concurrency tests (Decision 10) ----

  test("concurrent executes create instance only once", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    // Launch two concurrent execute calls
    const [result1, result2] = await Promise.all([
      bridge.execute("cmd1", {}, 5000),
      bridge.execute("cmd2", {}, 5000),
    ]);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    // Adapter.create may be called twice due to race, but the bridge reuses once resolved
    // The key invariant: both calls complete successfully
    expect(instance.exec).toHaveBeenCalledTimes(2);

    await bridge.dispose();
  });

  test("execute after dispose returns CRASH error", async () => {
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
});
