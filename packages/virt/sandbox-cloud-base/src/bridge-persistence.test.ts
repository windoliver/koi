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

function createMockInstance(overrides?: {
  readonly detach?: (() => Promise<void>) | undefined;
}): SandboxInstance {
  return {
    exec: mock(() => Promise.resolve(createMockResult())),
    readFile: mock(() => Promise.resolve(new Uint8Array())),
    writeFile: mock(() => Promise.resolve()),
    destroy: mock(() => Promise.resolve()),
    ...(overrides?.detach !== undefined ? { detach: overrides.detach } : {}),
  };
}

function createMockAdapter(
  instance: SandboxInstance,
  findOrCreate?: SandboxAdapter["findOrCreate"],
): SandboxAdapter {
  return {
    name: "mock",
    create: mock(() => Promise.resolve(instance)),
    ...(findOrCreate !== undefined ? { findOrCreate } : {}),
  };
}

describe("createCachedBridge persistence", () => {
  const profile: SandboxProfile = createTestProfile({ sandbox: true, capabilities: {} });

  // ---- Scope-less (undefined scope) → normal destroy ----

  test("dispose calls destroy when scope is undefined", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({ adapter, profile });

    await bridge.warmup();
    await bridge.dispose();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  // ---- Scoped dispose → detach ----

  test("dispose calls detach when scope is set and instance supports it", async () => {
    const detachFn = mock(() => Promise.resolve());
    const instance = createMockInstance({ detach: detachFn });
    const findOrCreate = mock(() => Promise.resolve(instance));
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await bridge.warmup();
    await bridge.dispose();

    expect(detachFn).toHaveBeenCalledTimes(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  test("dispose calls destroy when scope is set but instance lacks detach", async () => {
    const instance = createMockInstance();
    const findOrCreate = mock(() => Promise.resolve(instance));
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await bridge.warmup();
    await bridge.dispose();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  // ---- findOrCreate usage ----

  test("uses findOrCreate when scope set and adapter supports it", async () => {
    const instance = createMockInstance();
    const findOrCreate = mock(() => Promise.resolve(instance));
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await bridge.warmup();

    expect(findOrCreate).toHaveBeenCalledTimes(1);
    expect(findOrCreate).toHaveBeenCalledWith("my-agent", profile);
    expect(adapter.create).not.toHaveBeenCalled();

    await bridge.dispose();
  });

  test("falls back to create when scope set but adapter lacks findOrCreate", async () => {
    const instance = createMockInstance();
    const adapter: SandboxAdapter = {
      name: "simple",
      create: mock(() => Promise.resolve(instance)),
    };
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await bridge.warmup();

    expect(adapter.create).toHaveBeenCalledTimes(1);

    await bridge.dispose();
  });

  // ---- warmup with scope ----

  test("warmup with scope uses findOrCreate", async () => {
    const instance = createMockInstance();
    const findOrCreate = mock(() => Promise.resolve(instance));
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await bridge.warmup();

    expect(findOrCreate).toHaveBeenCalledTimes(1);
    expect(bridge.getInstance()).toBe(instance);

    await bridge.dispose();
  });

  // ---- Concurrent findOrCreate dedup ----

  test("concurrent warmup with scope creates instance only once", async () => {
    const instance = createMockInstance();
    const findOrCreate = mock(
      () => new Promise<SandboxInstance>((resolve) => setTimeout(() => resolve(instance), 50)),
    );
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    await Promise.all([bridge.warmup(), bridge.warmup(), bridge.warmup()]);

    expect(findOrCreate).toHaveBeenCalledTimes(1);

    await bridge.dispose();
  });

  // ---- Create failure retry with scope ----

  test("findOrCreate failure clears inflight and allows retry", async () => {
    let callCount = 0;
    const instance = createMockInstance();
    const findOrCreate = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve(instance);
    });
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({ adapter, profile, scope: "my-agent" });

    // First call fails
    const r1 = await bridge.execute("cmd", {}, 5000);
    expect(r1.ok).toBe(false);

    // Second call retries and succeeds
    const r2 = await bridge.execute("cmd", {}, 5000);
    expect(r2.ok).toBe(true);

    await bridge.dispose();
  });

  // ---- TTL with scope ----

  test("TTL expiry with scope calls detach not destroy", async () => {
    const detachFn = mock(() => Promise.resolve());
    const instance = createMockInstance({ detach: detachFn });
    const findOrCreate = mock(() => Promise.resolve(instance));
    const adapter = createMockAdapter(instance, findOrCreate);
    const bridge = createCachedBridge({
      adapter,
      profile,
      scope: "my-agent",
      ttlMs: 50,
    });

    await bridge.execute("cmd", {}, 5000);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(detachFn).toHaveBeenCalledTimes(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  // ---- TTL expiry without scope calls destroy ----

  test("TTL expiry without scope calls destroy", async () => {
    const instance = createMockInstance();
    const adapter = createMockAdapter(instance);
    const bridge = createCachedBridge({
      adapter,
      profile,
      ttlMs: 50,
    });

    await bridge.execute("cmd", {}, 5000);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });
});
