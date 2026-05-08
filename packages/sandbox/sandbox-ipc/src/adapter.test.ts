import { expect, test } from "bun:test";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import * as sandboxIpc from "./index.js";
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
