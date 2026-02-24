/**
 * Integration test — wires @koi/sandbox-ipc's bridgeToExecutor() into
 * createTieredExecutor() and verifies end-to-end execution through
 * the tiered dispatcher.
 *
 * Gated behind SANDBOX_INTEGRATION env var (spawns real Bun child processes).
 */

import { describe, expect, test } from "bun:test";
import { createSandboxCommand, restrictiveProfile } from "@koi/sandbox";
import type { BridgeConfig, SandboxBridge } from "@koi/sandbox-ipc";
import { bridgeToExecutor, createSandboxBridge } from "@koi/sandbox-ipc";
import { createTieredExecutor } from "../tiered-executor.js";

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

describe.skipIf(SKIP_INTEGRATION)("tiered executor + sandbox-ipc integration", () => {
  let bridge: SandboxBridge;

  test("routes sandbox tier through IPC bridge and returns result", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const ipcExecutor = bridgeToExecutor(bridge);

      const result = createTieredExecutor({ sandbox: ipcExecutor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const tiered = result.value;

      // Verify sandbox tier resolves to the IPC backend (no fallback)
      const resolution = tiered.forTier("sandbox");
      expect(resolution.resolvedTier).toBe("sandbox");
      expect(resolution.fallback).toBe(false);

      // Execute through the tiered dispatcher
      const execResult = await resolution.executor.execute("return 42", {}, 10_000);
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;
      expect(execResult.value.output).toBe(42);
      expect(execResult.value.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await bridge.dispose();
    }
  });

  test("passes input through tiered dispatcher to IPC sandbox", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const ipcExecutor = bridgeToExecutor(bridge);
      const result = createTieredExecutor({ sandbox: ipcExecutor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const execResult = await result.value
        .forTier("sandbox")
        .executor.execute("return input.a * input.b", { a: 6, b: 7 }, 10_000);

      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;
      expect(execResult.value.output).toBe(42);
    } finally {
      await bridge.dispose();
    }
  });

  test("promoted tier still uses built-in executor alongside IPC sandbox", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const ipcExecutor = bridgeToExecutor(bridge);
      const result = createTieredExecutor({ sandbox: ipcExecutor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const tiered = result.value;

      // Promoted resolves to built-in (not IPC)
      const promoted = tiered.forTier("promoted");
      expect(promoted.resolvedTier).toBe("promoted");
      expect(promoted.fallback).toBe(false);

      // Sandbox resolves to IPC
      const sandbox = tiered.forTier("sandbox");
      expect(sandbox.resolvedTier).toBe("sandbox");

      // Both execute correctly
      const [promotedResult, sandboxResult] = await Promise.all([
        promoted.executor.execute("return 'promoted'", {}, 5_000),
        sandbox.executor.execute("return 'sandbox'", {}, 10_000),
      ]);

      expect(promotedResult.ok).toBe(true);
      expect(sandboxResult.ok).toBe(true);
      if (promotedResult.ok) expect(promotedResult.value.output).toBe("promoted");
      if (sandboxResult.ok) expect(sandboxResult.value.output).toBe("sandbox");
    } finally {
      await bridge.dispose();
    }
  });

  test("IPC sandbox error propagates through tiered dispatcher", async () => {
    bridge = await createSandboxBridge(integrationBridgeConfig());
    try {
      const ipcExecutor = bridgeToExecutor(bridge);
      const result = createTieredExecutor({ sandbox: ipcExecutor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const execResult = await result.value
        .forTier("sandbox")
        .executor.execute('throw new Error("boom")', {}, 10_000);

      expect(execResult.ok).toBe(false);
      if (execResult.ok) return;
      expect(execResult.error.code).toBeDefined();
    } finally {
      await bridge.dispose();
    }
  });
});
