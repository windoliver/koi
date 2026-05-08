import { describe, expect, test } from "bun:test";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, CommandBuilder, IpcProcess, SpawnFn } from "./types.js";

const TEST_PROFILE: BridgeConfig["profile"] = {
  filesystem: {
    defaultReadAccess: "closed",
    allowRead: ["/usr", "/bin", "/tmp"],
    allowWrite: ["/tmp"],
  },
  network: { allow: false },
  resources: { timeoutMs: 25, maxMemoryMb: 128 },
};

const passThroughCommandBuilder: CommandBuilder = (_profile, command, args) => ({
  ok: true,
  value: { executable: command, args: [...args] },
});

function createConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    profile: TEST_PROFILE,
    buildCommand: passThroughCommandBuilder,
    serialization: "json",
    graceMs: 10,
    maxResultBytes: 1_024,
    ...overrides,
  };
}

function createMockSpawn(behavior: {
  readonly onCreated?: (control: MockControl) => void;
  readonly onHostMessage?: (message: unknown, control: MockControl) => void;
}): { readonly spawnFn: SpawnFn; readonly state: MockState } {
  const state: MockState = {
    command: undefined,
    serialization: undefined,
    sentMessages: [],
    killSignals: [],
  };

  const spawnFn: SpawnFn = (command, options) => {
    state.command = [...command];
    state.serialization = options.serialization;

    let messageHandler: ((message: unknown) => void) | undefined;
    let exitCode = 0;
    let exited = false;
    let resolveExit!: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const control: MockControl = {
      sendToHost(message) {
        queueMicrotask(() => {
          messageHandler?.(message);
        });
      },
      exitWith(code) {
        if (exited) {
          return;
        }
        exited = true;
        exitCode = code;
        resolveExit(code);
      },
    };

    const proc: IpcProcess = {
      pid: 42_000,
      exited: exitedPromise,
      kill(signal) {
        state.killSignals.push(signal ?? 9);
        control.exitWith(128 + (signal ?? 9));
      },
      send(message) {
        state.sentMessages.push(message);
        behavior.onHostMessage?.(message, control);
      },
      onMessage(handler) {
        messageHandler = handler;
      },
      onExit(handler) {
        void exitedPromise.then((code) => {
          handler(code);
        });
      },
    };

    queueMicrotask(() => {
      behavior.onCreated?.(control);
    });

    void proc.exited.then((code) => {
      exitCode = code;
    });
    void exitCode;

    return proc;
  };

  return { spawnFn, state };
}

interface MockControl {
  readonly sendToHost: (message: unknown) => void;
  readonly exitWith: (code: number) => void;
}

interface MockState {
  command: string[] | undefined;
  serialization: "advanced" | "json" | undefined;
  sentMessages: unknown[];
  killSignals: number[];
}

describe("createSandboxBridge", () => {
  test("returns a structured result on the happy path", async () => {
    const mock = createMockSpawn({
      onCreated(control) {
        control.sendToHost({ kind: "ready" });
      },
      onHostMessage(message, control) {
        expect(message).toEqual({
          kind: "execute",
          code: "return input.value + 1;",
          input: { value: 41 },
          timeoutMs: 25,
        });

        control.sendToHost({
          kind: "result",
          output: 42,
          durationMs: 7,
          memoryUsedBytes: 512,
        });
        control.exitWith(0);
      },
    });

    const bridge = await createSandboxBridge(createConfig(), { spawnFn: mock.spawnFn });

    try {
      const result = await bridge.execute("return input.value + 1;", { value: 41 });

      expect(result).toEqual({
        ok: true,
        value: {
          output: 42,
          durationMs: 7,
          memoryUsedBytes: 512,
          exitCode: 0,
          spawnDurationMs: expect.any(Number),
        },
      });
      expect(mock.state.command).toEqual(["bun", "run", expect.any(String)]);
      expect(mock.state.serialization).toBe("json");
    } finally {
      await bridge.dispose();
    }
  });

  test("maps worker-thrown errors to bridge worker errors", async () => {
    const mock = createMockSpawn({
      onCreated(control) {
        control.sendToHost({ kind: "ready" });
      },
      onHostMessage(_message, control) {
        control.sendToHost({
          kind: "error",
          code: "CRASH",
          message: "worker exploded",
          durationMs: 3,
        });
        control.exitWith(1);
      },
    });

    const bridge = await createSandboxBridge(createConfig(), { spawnFn: mock.spawnFn });

    try {
      const result = await bridge.execute('throw new Error("worker exploded");', {});

      expect(result).toEqual({
        ok: false,
        error: {
          code: "WORKER_ERROR",
          message: "worker exploded",
          durationMs: 3,
        },
      });
    } finally {
      await bridge.dispose();
    }
  });

  test("returns TIMEOUT and kills the worker when execution exceeds the bridge timeout", async () => {
    const mock = createMockSpawn({
      onCreated(control) {
        control.sendToHost({ kind: "ready" });
      },
      onHostMessage() {
        // Intentionally never respond.
      },
    });

    const bridge = await createSandboxBridge(
      createConfig({
        profile: {
          ...TEST_PROFILE,
          resources: { ...TEST_PROFILE.resources, timeoutMs: 15 },
        },
        graceMs: 5,
      }),
      { spawnFn: mock.spawnFn },
    );

    try {
      const result = await bridge.execute("while (true) {}", {}, { timeoutMs: 15 });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected timeout result");
      }
      expect(result.error.code).toBe("TIMEOUT");
      expect(mock.state.killSignals).toContain(9);
    } finally {
      await bridge.dispose();
    }
  });

  test("enforces the host-side max result size limit", async () => {
    const mock = createMockSpawn({
      onCreated(control) {
        control.sendToHost({ kind: "ready" });
      },
      onHostMessage(_message, control) {
        control.sendToHost({
          kind: "result",
          output: "x".repeat(256),
          durationMs: 4,
        });
      },
    });

    const bridge = await createSandboxBridge(
      createConfig({
        maxResultBytes: 32,
      }),
      { spawnFn: mock.spawnFn },
    );

    try {
      const result = await bridge.execute('return "x".repeat(256);', {});

      expect(result).toEqual({
        ok: false,
        error: {
          code: "RESULT_TOO_LARGE",
          message: expect.stringContaining("exceeds limit"),
          durationMs: expect.any(Number),
        },
      });
      expect(mock.state.killSignals).toContain(9);
    } finally {
      await bridge.dispose();
    }
  });

  test("returns DISPOSED after disposal and allows dispose to be called twice", async () => {
    const bridge = await createSandboxBridge(createConfig());

    await bridge.dispose();
    await bridge.dispose();

    const result = await bridge.execute("return 1;", {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DISPOSED",
        message: "Bridge has been disposed",
      },
    });
  });

  test("adds the generated worker path to the effective read profile before command building", async () => {
    const seen: {
      profile?: BridgeConfig["profile"];
      args?: readonly string[];
    } = {};
    const buildCommand: CommandBuilder = (profile, command, args) => {
      seen.profile = profile;
      seen.args = args;
      return {
        ok: true,
        value: { executable: command, args: [...args] },
      };
    };

    const mock = createMockSpawn({
      onCreated(control) {
        control.sendToHost({ kind: "ready" });
      },
      onHostMessage(_message, control) {
        control.sendToHost({
          kind: "result",
          output: "ok",
          durationMs: 1,
        });
        control.exitWith(0);
      },
    });

    const bridge = await createSandboxBridge(
      createConfig({
        profile: {
          filesystem: {
            defaultReadAccess: "closed",
            allowRead: ["/usr"],
            allowWrite: ["/tmp"],
          },
          network: { allow: false },
          resources: { timeoutMs: 25, maxMemoryMb: 128 },
        },
        buildCommand,
      }),
      { spawnFn: mock.spawnFn },
    );

    try {
      const result = await bridge.execute("return 'ok';", {});
      expect(result.ok).toBe(true);

      expect(seen.args).toEqual(["run", expect.any(String)]);
      expect(seen.profile?.filesystem.allowRead).toContain(seen.args?.[1]);
    } finally {
      await bridge.dispose();
    }
  });
});
