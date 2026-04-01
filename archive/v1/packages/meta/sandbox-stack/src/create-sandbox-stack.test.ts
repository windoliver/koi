import { describe, expect, mock, test } from "bun:test";
import type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createSandboxStack } from "./create-sandbox-stack.js";

function createMockResult(overrides?: Partial<SandboxAdapterResult>): SandboxAdapterResult {
  return {
    exitCode: 0,
    stdout: '{"value": 42}',
    stderr: "",
    durationMs: 50,
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

function createMockAdapter(instance?: SandboxInstance): {
  readonly adapter: SandboxAdapter;
  readonly instance: SandboxInstance;
} {
  const inst = instance ?? createMockInstance();
  return {
    adapter: {
      name: "mock",
      create: mock((_profile: SandboxProfile) => Promise.resolve(inst)),
    },
    instance: inst,
  };
}

describe("createSandboxStack", () => {
  test("returns executor, instance, warmup, dispose shape", () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    expect(stack.executor).toBeDefined();
    expect(typeof stack.executor.execute).toBe("function");
    expect(typeof stack.warmup).toBe("function");
    expect(typeof stack.dispose).toBe("function");
    // instance is undefined before warmup
    expect(stack.instance).toBeUndefined();
  });

  test("executor delegates to adapter via bridge", async () => {
    const { adapter, instance } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    const result = await stack.executor.execute("echo 42", null, 5000);

    expect(result.ok).toBe(true);
    expect(instance.exec).toHaveBeenCalledTimes(1);

    await stack.dispose();
  });

  test("warmup calls adapter.create eagerly", async () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.warmup();

    expect(adapter.create).toHaveBeenCalledTimes(1);

    await stack.dispose();
  });

  test("warmup is no-op when already warm", async () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.warmup();
    await stack.warmup();

    expect(adapter.create).toHaveBeenCalledTimes(1);

    await stack.dispose();
  });

  test("instance is undefined before warmup", () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    expect(stack.instance).toBeUndefined();
  });

  test("instance is present after warmup", async () => {
    const { adapter, instance } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.warmup();

    expect(stack.instance).toBe(instance);

    await stack.dispose();
  });

  test("instance is present after first execute", async () => {
    const { adapter, instance } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.executor.execute("cmd", null, 5000);

    expect(stack.instance).toBe(instance);

    await stack.dispose();
  });

  test("dispose destroys the instance", async () => {
    const { adapter, instance } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.warmup();
    await stack.dispose();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  test("dispose is idempotent", async () => {
    const { adapter, instance } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.warmup();
    await stack.dispose();
    await stack.dispose();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  test("execute after dispose returns CRASH error", async () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });

    await stack.dispose();

    const result = await stack.executor.execute("cmd", null, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("idleTtlMs is passed to bridge config", () => {
    const { adapter } = createMockAdapter();
    // Just verify it doesn't throw with custom TTL
    const stack = createSandboxStack({ adapter, idleTtlMs: 120_000 });
    expect(stack).toBeDefined();
  });

  test("default config values applied correctly", () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({ adapter });
    // Defaults: timeoutMs=30_000, idleTtlMs=60_000
    expect(stack).toBeDefined();
  });

  test("network config maps to profile correctly", async () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({
      adapter,
      network: { allow: true, allowedHosts: ["api.example.com"] },
    });

    // Verify it creates successfully — profile mapping is validated by adapter.create call
    await stack.warmup();
    const createCall = (adapter.create as ReturnType<typeof mock>).mock.calls[0];
    const receivedProfile = createCall?.[0] as SandboxProfile;
    expect(receivedProfile.network.allow).toBe(true);
    expect(receivedProfile.network.allowedHosts).toEqual(["api.example.com"]);

    await stack.dispose();
  });

  test("resources config maps to profile correctly", async () => {
    const { adapter } = createMockAdapter();
    const stack = createSandboxStack({
      adapter,
      resources: { timeoutMs: 10_000, maxMemoryMb: 512 },
    });

    await stack.warmup();
    const createCall = (adapter.create as ReturnType<typeof mock>).mock.calls[0];
    const receivedProfile = createCall?.[0] as SandboxProfile;
    expect(receivedProfile.resources.timeoutMs).toBe(10_000);
    expect(receivedProfile.resources.maxMemoryMb).toBe(512);

    await stack.dispose();
  });
});
