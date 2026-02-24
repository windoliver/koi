/**
 * Integration tests — real process spawning (gated behind SANDBOX_INTEGRATION env var).
 *
 * These tests spawn actual sandboxed Bun processes with IPC enabled.
 * They require macOS (seatbelt) or Linux (bwrap) sandbox tooling to be available.
 */

import { describe, expect, test } from "bun:test";
import { createSandboxCommand, restrictiveProfile } from "@koi/sandbox";
import { createSandboxBridge } from "../bridge.js";
import type { BridgeConfig } from "../types.js";

const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION;

function integrationConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
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

describe.skipIf(SKIP_INTEGRATION)("sandbox-ipc integration", () => {
  test("executes simple code and returns result", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    try {
      const result = await bridge.execute("return 42", {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.output).toBe(42);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.value.exitCode).toBe(0);
    } finally {
      await bridge.dispose();
    }
  });

  test("passes input to executed code", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    try {
      const result = await bridge.execute("return input.x + input.y", { x: 10, y: 20 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.output).toBe(30);
    } finally {
      await bridge.dispose();
    }
  });

  test("handles code that throws", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    try {
      const result = await bridge.execute('throw new Error("oops")', {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["WORKER_ERROR", "CRASH"]).toContain(result.error.code);
    } finally {
      await bridge.dispose();
    }
  });

  test("handles code that times out", async () => {
    const bridge = await createSandboxBridge(
      integrationConfig({
        profile: restrictiveProfile({
          resources: { timeoutMs: 500, maxMemoryMb: 256 },
        }),
        graceMs: 2_000,
      }),
    );
    try {
      const result = await bridge.execute("while(true){}", {}, { timeoutMs: 500 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["TIMEOUT"]).toContain(result.error.code);
    } finally {
      await bridge.dispose();
    }
  });

  test("returns correct result for async code", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    try {
      const result = await bridge.execute("return await Promise.resolve({ msg: 'hello' })", {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.output).toEqual({ msg: "hello" });
    } finally {
      await bridge.dispose();
    }
  });

  test("dispose is idempotent", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    await bridge.dispose();
    await bridge.dispose(); // Should not throw
  });

  test("execute after dispose returns DISPOSED", async () => {
    const bridge = await createSandboxBridge(integrationConfig());
    await bridge.dispose();
    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DISPOSED");
  });
});
