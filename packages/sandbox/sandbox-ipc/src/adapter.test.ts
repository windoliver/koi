import { expect, test } from "bun:test";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import { bridgeToExecutor as createExecutor } from "./adapter.js";
import type { BridgeConfig, CommandBuilder, SandboxBridge } from "./types.js";

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
    // Adapter tests target the IPC happy/failure paths, not descendant
    // teardown. Opt out of fail-closed setsid checks for portability.
    processGroupIsolation: "best-effort",
  };
}

type CreateBridge = (config: BridgeConfig) => Promise<SandboxBridge> | SandboxBridge;

function bridgeToExecutor(config: BridgeConfig, createBridge?: CreateBridge): SandboxExecutor {
  return createExecutor(config, createBridge === undefined ? undefined : { createBridge });
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

test("bridgeToExecutor preserves primitive input semantics", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("return input + 1", 41, 500);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected primitive input to succeed");
  }

  expect(result.value.output).toBe(42);
});

test("bridgeToExecutor preserves null input semantics", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("return input === null", null, 500);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected null input to succeed");
  }

  expect(result.value.output).toBe(true);
});

test("bridgeToExecutor preserves array input semantics", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute(
    "return Array.isArray(input) ? input[0] + input[1] : -1",
    [19, 23],
    500,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected array input to succeed");
  }

  expect(result.value.output).toBe(42);
});

test("bridgeToExecutor maps non-IPC code exceptions into valid SandboxError results", async () => {
  const executor = bridgeToExecutor(validBridgeConfig(), async () => {
    throw { code: "EACCES", message: "permission denied" };
  });
  const result = await executor.execute("return 1", {}, 500);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected create failure");
  }

  expect(result.error.code).toBe("PERMISSION");
  expect(result.error.message).toContain("permission denied");
});

test("bridgeToExecutor maps bridge creation failures into SandboxError results", async () => {
  const executor = bridgeToExecutor(validBridgeConfig(), async () => {
    throw new Error("bridge creation exploded");
  });

  await expect(executor.execute("return 1", {}, 500)).resolves.toMatchObject({
    ok: false,
    error: {
      code: "CRASH",
      message: "bridge creation exploded",
      durationMs: 0,
    },
  });
});

test("bridgeToExecutor preserves a successful execution when dispose fails", async () => {
  // A disposal failure after a successful execute must not flip the result —
  // user code already ran and may have side-effects. Cleanup errors are
  // swallowed (and surfaced via telemetry, not the executor result).
  const executor = bridgeToExecutor(validBridgeConfig(), async () =>
    makeMockBridge({
      execute: async () => ({
        ok: true,
        value: { output: 99, durationMs: 3, exitCode: 0 },
      }),
      dispose: async () => {
        throw new Error("bridge disposal exploded");
      },
    }),
  );

  const result = await executor.execute("return 99", {}, 500);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.value.output).toBe(99);
});

test("bridgeToExecutor preserves an execution failure when dispose also fails", async () => {
  const executor = bridgeToExecutor(validBridgeConfig(), async () =>
    makeMockBridge({
      execute: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "execution timed out", durationMs: 17 },
      }),
      dispose: async () => {
        throw new Error("bridge disposal exploded");
      },
    }),
  );
  const result = await executor.execute("return 1", {}, 500);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected execution failure");
  }

  expect(result.error.code).toBe("TIMEOUT");
  expect(result.error.message).toBe("execution timed out");
  expect(result.error.durationMs).toBe(17);
});
