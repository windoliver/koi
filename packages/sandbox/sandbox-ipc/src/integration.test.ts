import { describe, expect, test } from "bun:test";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, CommandBuilder } from "./types.js";

const TEST_PROFILE: BridgeConfig["profile"] = {
  filesystem: {
    defaultReadAccess: "closed",
    allowRead: ["/usr", "/bin", "/tmp"],
    allowWrite: ["/tmp"],
  },
  network: { allow: false },
  resources: { timeoutMs: 250, maxMemoryMb: 128 },
};

function createIntegrationConfig(
  buildCommand: CommandBuilder,
  overrides: Partial<BridgeConfig> = {},
): BridgeConfig {
  return {
    profile: TEST_PROFILE,
    buildCommand,
    serialization: "advanced",
    graceMs: 100,
    maxResultBytes: 16_384,
    // Integration tests run on dev hosts that may not have `setsid`. Tests
    // exercise the IPC happy paths, not descendant teardown, so opt out of
    // the fail-closed default explicitly.
    processGroupIsolation: "best-effort",
    ...overrides,
  };
}

describe("sandbox-ipc real Bun child integration", () => {
  test("passes input into the worker and returns structured output", async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const buildCommand: CommandBuilder = (_profile, command, args) => {
      commands.push({ command, args });
      return {
        ok: true,
        value: { executable: "bun", args: ["run", args[1] as string] },
      };
    };

    const bridge = await createSandboxBridge(createIntegrationConfig(buildCommand));

    try {
      const result = await bridge.execute(
        "return { total: input.left + input.right, label: input.label };",
        { left: 19, right: 23, label: "seen-by-worker" },
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]).toEqual({
        command: "bun",
        args: ["run", expect.any(String)],
      });
      expect(result).toEqual({
        ok: true,
        value: {
          output: { total: 42, label: "seen-by-worker" },
          durationMs: expect.any(Number),
          exitCode: 0,
          spawnDurationMs: expect.any(Number),
        },
      });
    } finally {
      await bridge.dispose();
    }
  });

  test("maps thrown worker code into a typed bridge error result", async () => {
    const buildCommand: CommandBuilder = (_profile, command, args) => ({
      ok: true,
      value: { executable: command, args: [...args] },
    });

    const bridge = await createSandboxBridge(createIntegrationConfig(buildCommand));

    try {
      const result = await bridge.execute('throw new Error("boom from worker");', {});

      expect(result).toEqual({
        ok: false,
        error: {
          code: "WORKER_ERROR",
          message: expect.stringContaining("boom from worker"),
          durationMs: expect.any(Number),
        },
      });
    } finally {
      await bridge.dispose();
    }
  });

  test("preserves BigInt results when advanced serialization is enabled", async () => {
    const buildCommand: CommandBuilder = (_profile, command, args) => ({
      ok: true,
      value: { executable: command, args: [...args] },
    });

    const bridge = await createSandboxBridge(createIntegrationConfig(buildCommand));

    try {
      const result = await bridge.execute("return 42n;", {});

      expect(result).toEqual({
        ok: true,
        value: {
          output: 42n,
          durationMs: expect.any(Number),
          exitCode: 0,
          spawnDurationMs: expect.any(Number),
        },
      });
    } finally {
      await bridge.dispose();
    }
  });
});
