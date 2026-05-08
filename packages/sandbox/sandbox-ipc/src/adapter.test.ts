import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import * as sandboxIpc from "./index.js";
import type { SandboxBridge } from "./types.js";
import type { BridgeConfig, CommandBuilder } from "./types.js";

const TEST_PROFILE: BridgeConfig["profile"] = {
  filesystem: {
    defaultReadAccess: "closed",
    allowRead: ["/usr", "/bin", "/tmp"],
    allowWrite: ["/tmp"],
  },
  network: { allow: false },
  resources: { timeoutMs: 500, maxMemoryMb: 128 },
};

const passThroughCommandBuilder: CommandBuilder = (_profile, command, args) => ({
  ok: true,
  value: { executable: command, args: [...args] },
});

function validBridgeConfig(): BridgeConfig {
  return {
    profile: TEST_PROFILE,
    buildCommand: passThroughCommandBuilder,
    serialization: "advanced",
    graceMs: 25,
    maxResultBytes: 16_384,
  };
}

function bridgeToExecutor(config: BridgeConfig): SandboxExecutor {
  return (
    sandboxIpc as typeof sandboxIpc & {
      bridgeToExecutor: (bridgeConfig: BridgeConfig) => SandboxExecutor;
    }
  ).bridgeToExecutor(config);
}

async function importAdapter() {
  return import(`./adapter.js?ts=${Date.now()}-${Math.random()}`);
}

function makeMockBridge(overrides: Partial<SandboxBridge> = {}): SandboxBridge {
  return {
    execute: async () => ({
      ok: true,
      value: { output: 42, durationMs: 5, exitCode: 0 },
    }),
    dispose: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  mock.restore();
});

afterEach(() => {
  mock.restore();
});

test("bridgeToExecutor adapts bridge failures into SandboxError results", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("throw new Error('boom')", {}, 500);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected failure");
  }

  expect(result.error.code).toBe("CRASH");
});

test("bridgeToExecutor returns SandboxResult values on success", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute(
    "return { total: input.left + input.right, memorySeen: 1234 };",
    { left: 19, right: 23 },
    500,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected success");
  }

  expect(result.value.output).toEqual({ total: 42, memorySeen: 1234 });
  expect(result.value.durationMs).toEqual(expect.any(Number));
});

test("bridgeToExecutor preserves TIMEOUT failures", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("while (true) {}", {}, 10);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected timeout");
  }

  expect(result.error.code).toBe("TIMEOUT");
});

test("bridgeToExecutor rejects non-object input", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("return input", "not-an-object", 500);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected invalid-input failure");
  }

  expect(result.error.code).toBe("CRASH");
  expect(result.error.message).toContain("plain object input");
});

test("bridgeToExecutor maps bridge creation failures into SandboxError results", async () => {
  mock.module("./bridge.js", () => ({
    createSandboxBridge: mock(async () => {
      throw new Error("bridge creation exploded");
    }),
  }));
  const { bridgeToExecutor } = await importAdapter();
  const executor = bridgeToExecutor(validBridgeConfig());

  await expect(executor.execute("return 1", {}, 500)).resolves.toMatchObject({
    ok: false,
    error: {
      code: "CRASH",
      message: "bridge creation exploded",
      durationMs: 0,
    },
  });
});

test("bridgeToExecutor maps bridge disposal failures into SandboxError results", async () => {
  mock.module("./bridge.js", () => ({
    createSandboxBridge: mock(async () =>
      makeMockBridge({
        dispose: async () => {
          throw new Error("bridge disposal exploded");
        },
      }),
    ),
  }));
  const { bridgeToExecutor } = await importAdapter();
  const executor = bridgeToExecutor(validBridgeConfig());

  await expect(executor.execute("return 1", {}, 500)).resolves.toMatchObject({
    ok: false,
    error: {
      code: "CRASH",
      message: "bridge disposal exploded",
      durationMs: 0,
    },
  });
});
