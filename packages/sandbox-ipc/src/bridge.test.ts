/**
 * Bridge tests — mock IPC channel failure mode tests (12 scenarios).
 *
 * Uses dependency-injected spawnFn to simulate IPC without real processes.
 */

import { describe, expect, test } from "bun:test";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, CommandBuilder, IpcProcess, SpawnFn } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PROFILE: BridgeConfig["profile"] = {
  tier: "sandbox",
  filesystem: {
    allowRead: ["/usr", "/bin", "/lib", "/etc", "/tmp"],
    allowWrite: ["/tmp/koi-sandbox-*"],
  },
  network: { allow: false },
  resources: {
    maxMemoryMb: 512,
    timeoutMs: 5_000,
  },
};

/** Mock command builder that returns the command as-is (no sandboxing). */
const mockBuildCommand: CommandBuilder = (_profile, command, args) => ({
  ok: true,
  value: { executable: command, args: [...args] },
});

function testConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    profile: TEST_PROFILE,
    buildCommand: mockBuildCommand,
    serialization: "json",
    graceMs: 1_000,
    maxResultBytes: 1_048_576, // 1 MB for tests
    ...overrides,
  };
}

function createDirectMockSpawn(behavior: {
  onCreated?: (proc: {
    sendToHost: (msg: unknown) => void;
    exitWith: (code: number) => void;
  }) => void;
  onMessageFromHost?: (
    msg: unknown,
    proc: { sendToHost: (msg: unknown) => void; exitWith: (code: number) => void },
  ) => void;
}): SpawnFn {
  return (_cmd, _options) => {
    const handlers: {
      messageHandler?: (message: unknown) => void;
      exitHandlers: Array<(code: number) => void>;
    } = { exitHandlers: [] };

    let exitResolved = false;
    let exitResolve: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      exitResolve = resolve;
    });

    const procControl = {
      sendToHost: (msg: unknown) => {
        queueMicrotask(() => {
          handlers.messageHandler?.(msg);
        });
      },
      exitWith: (code: number) => {
        if (!exitResolved) {
          exitResolved = true;
          exitResolve(code);
        }
      },
    };

    const proc: IpcProcess = {
      pid: 12345,
      exited: exitPromise,
      kill: (_signal?: number) => {
        procControl.exitWith(137);
      },
      send: (message: unknown) => {
        behavior.onMessageFromHost?.(message, procControl);
      },
      onMessage: (handler: (message: unknown) => void) => {
        handlers.messageHandler = handler;
      },
      onExit: (handler: (code: number) => void) => {
        handlers.exitHandlers.push(handler);
        exitPromise.then((code) => {
          for (const h of handlers.exitHandlers) {
            h(code);
          }
        });
      },
    };

    // Trigger onCreated after the proc is wired up
    queueMicrotask(() => {
      behavior.onCreated?.(procControl);
    });

    return proc;
  };
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

describe("createSandboxBridge", () => {
  // Scenario 1: Successful execution (happy path)
  test("successful execution returns result", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (msg, proc) => {
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { kind: string }).kind === "execute"
        ) {
          proc.sendToHost({
            kind: "result",
            output: 42,
            durationMs: 10,
          });
          proc.exitWith(0);
        }
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 42", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe(42);
    expect(result.value.exitCode).toBe(0);

    await bridge.dispose();
  });

  // Scenario 2: Worker sends error response
  test("worker error response maps to IPC error", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (msg, proc) => {
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { kind: string }).kind === "execute"
        ) {
          proc.sendToHost({
            kind: "error",
            code: "TIMEOUT",
            message: "execution timed out",
            durationMs: 5000,
          });
          proc.exitWith(1);
        }
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("while(true){}", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");

    await bridge.dispose();
  });

  // Scenario 3: Process exits before sending "ready"
  test("process exit before ready returns CRASH", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.exitWith(1);
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CRASH");

    await bridge.dispose();
  });

  // Scenario 4: Process exits before sending result
  test("process exit before result returns CRASH", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        // Process crashes after receiving execute message
        proc.exitWith(1);
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CRASH");

    await bridge.dispose();
  });

  // Scenario 5: Process sends malformed message (Zod validation fails)
  test("malformed worker message returns DESERIALIZE error", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        // Send a message with invalid shape
        proc.sendToHost({ kind: "result", output: 42 }); // missing durationMs
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DESERIALIZE");

    await bridge.dispose();
  });

  // Scenario 6: Bridge timeout fires before worker responds
  test("bridge timeout returns TIMEOUT error", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: () => {
        // Worker never responds — bridge timeout will fire
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig({
        profile: {
          ...TEST_PROFILE,
          resources: { ...TEST_PROFILE.resources, timeoutMs: 100 },
        },
        graceMs: 100,
      }),
      spawnFn,
    });

    const result = await bridge.execute("while(true){}", {}, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");

    await bridge.dispose();
  });

  // Scenario 7: Worker sends response exceeding maxResultBytes
  test("oversized result returns RESULT_TOO_LARGE error", async () => {
    const largeOutput = "x".repeat(2_000_000); // 2MB > 1MB limit

    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        proc.sendToHost({
          kind: "result",
          output: largeOutput,
          durationMs: 10,
        });
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig({ maxResultBytes: 1_048_576 }), // 1MB
      spawnFn,
    });

    const result = await bridge.execute("return bigString", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RESULT_TOO_LARGE");

    await bridge.dispose();
  });

  // Scenario 8: Bun.spawn() throws (SPAWN_FAILED)
  test("spawn failure returns SPAWN_FAILED error", async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error("spawn failed: permission denied");
    };

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SPAWN_FAILED");
    expect(result.error.message).toContain("permission denied");

    await bridge.dispose();
  });

  // Scenario 9: Execute called after dispose (DISPOSED)
  test("execute after dispose returns DISPOSED error", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    await bridge.dispose();

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DISPOSED");

    // Dispose should be idempotent
    await bridge.dispose();
  });

  // Scenario 10: Signal forwarding (process killed by SIGTERM)
  test("process killed by signal returns CRASH with signal info", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        // Simulate SIGTERM (exit code 143 = 128 + 15)
        proc.exitWith(143);
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("return 1", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CRASH");
    expect(result.error.exitCode).toBe(143);

    await bridge.dispose();
  });

  // Scenario 11: OOM detection (exit code 137 without timeout)
  test("exit code 137 returns OOM error", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        // Simulate OOM kill (SIGKILL = exit 137)
        proc.exitWith(137);
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("new Array(1e9)", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OOM");
    expect(result.error.exitCode).toBe(137);
    expect(result.error.signal).toBe("SIGKILL");

    await bridge.dispose();
  });

  // Scenario 12: Worker OOM error response
  test("worker OOM error response maps correctly", async () => {
    const spawnFn = createDirectMockSpawn({
      onCreated: (proc) => {
        proc.sendToHost({ kind: "ready" });
      },
      onMessageFromHost: (_msg, proc) => {
        proc.sendToHost({
          kind: "error",
          code: "OOM",
          message: "out of memory",
          durationMs: 100,
        });
        proc.exitWith(1);
      },
    });

    const bridge = await createSandboxBridge({
      config: testConfig(),
      spawnFn,
    });

    const result = await bridge.execute("new Array(1e9)", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OOM");
    expect(result.error.message).toBe("out of memory");

    await bridge.dispose();
  });
});
