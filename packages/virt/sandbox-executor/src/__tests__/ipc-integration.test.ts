/**
 * Integration test — wires @koi/sandbox-ipc's bridgeToExecutor() into
 * a SandboxExecutor and verifies end-to-end execution through the bridge.
 *
 * Gated behind SANDBOX_INTEGRATION env var (spawns real Bun child processes).
 */

import { describe, expect, test } from "bun:test";
import { createSandboxCommand, restrictiveProfile } from "@koi/sandbox";
import type { BridgeConfig, SandboxBridge } from "@koi/sandbox-ipc";
import { bridgeToExecutor, createSandboxBridge } from "@koi/sandbox-ipc";

const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION;

function integrationBridgeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    profile: restrictiveProfile({
      resources: { timeoutMs: 10_000, maxMemoryMb: 256 },
    }),
    buildCommand: createSandboxCommand,
    serialization: "json",
    graceMs: 5_000,
    maxResultBytes: 10_485_760,
    ...overrides,
  };
}

describe.skipIf(SKIP_INTEGRATION)("sandbox-ipc bridge integration", () => {
  let bridge: SandboxBridge;

  test("executes code through IPC bridge and returns result", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const executor = bridgeToExecutor(bridge);

      const execResult = await executor.execute("return 42", {}, 10_000);
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;
      expect(execResult.value.output).toBe(42);
      expect(execResult.value.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await bridge.dispose();
    }
  });

  test("passes input through IPC bridge", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const executor = bridgeToExecutor(bridge);

      const execResult = await executor.execute("return input.a * input.b", { a: 6, b: 7 }, 10_000);

      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;
      expect(execResult.value.output).toBe(42);
    } finally {
      await bridge.dispose();
    }
  });

  test("IPC bridge error propagates correctly", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const executor = bridgeToExecutor(bridge);

      const execResult = await executor.execute('throw new Error("boom")', {}, 10_000);

      expect(execResult.ok).toBe(false);
      if (execResult.ok) return;
      expect(execResult.error.code).toBeDefined();
    } finally {
      await bridge.dispose();
    }
  });
});
