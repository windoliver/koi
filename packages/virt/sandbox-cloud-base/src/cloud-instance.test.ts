import { describe, expect, mock, test } from "bun:test";
import type { SandboxInstance } from "@koi/core";
import type {
  CloudInstanceConfig,
  CloudSdkProcessHandle,
  CloudSdkSandbox,
} from "./cloud-instance.js";
import { createCloudInstance } from "./cloud-instance.js";

/** Assert spawn is defined and call it — avoids optional chaining type issues. */
async function spawnOrFail(
  instance: SandboxInstance,
  cmd: string,
  args: readonly string[],
  opts?: Parameters<NonNullable<SandboxInstance["spawn"]>>[2],
): ReturnType<NonNullable<SandboxInstance["spawn"]>> {
  if (instance.spawn === undefined) {
    throw new Error("spawn is not defined on instance");
  }
  return instance.spawn(cmd, args, opts);
}

function createMockSdk(overrides?: {
  readonly runResult?: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly runError?: Error;
}): CloudSdkSandbox {
  return {
    commands: {
      run: mock(() => {
        if (overrides?.runError) return Promise.reject(overrides.runError);
        return Promise.resolve(overrides?.runResult ?? { exitCode: 0, stdout: "ok", stderr: "" });
      }),
    },
    files: {
      read: mock(() => Promise.resolve("file content")),
      write: mock(() => Promise.resolve()),
    },
  };
}

function createMockConfig(sdkOverrides?: Parameters<typeof createMockSdk>[0]): CloudInstanceConfig {
  const sdk = createMockSdk(sdkOverrides);
  return {
    sdk,
    classifyError: (error: unknown, durationMs: number) => ({
      code: "CRASH" as const,
      message: error instanceof Error ? error.message : String(error),
      durationMs,
    }),
    destroy: mock(() => Promise.resolve()),
    name: "test",
  };
}

describe("createCloudInstance", () => {
  test("exec runs command and returns result", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    const result = await instance.exec("echo", ["hello"], { timeoutMs: 5000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(config.sdk.commands.run).toHaveBeenCalledTimes(1);
  });

  test("exec joins command and args", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.exec("echo", ["hello", "world"], {});

    expect(config.sdk.commands.run).toHaveBeenCalledWith("echo hello world", expect.anything());
  });

  test("exec passes options to SDK", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.exec("ls", [], {
      cwd: "/tmp",
      env: { FOO: "bar" },
      timeoutMs: 3000,
    });

    const callArgs = (config.sdk.commands.run as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      cwd: "/tmp",
      envs: { FOO: "bar" },
      timeoutMs: 3000,
    });
  });

  test("exec calls streaming callbacks", async () => {
    const config = createMockConfig({ runResult: { exitCode: 0, stdout: "", stderr: "" } });
    const instance = createCloudInstance(config);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    // We need to trigger the callbacks during run. Overwrite mock to call them.
    (config.sdk.commands.run as ReturnType<typeof mock>).mockImplementation(
      (
        _cmd: string,
        opts?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void },
      ) => {
        opts?.onStdout?.("out1");
        opts?.onStderr?.("err1");
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    );

    await instance.exec("cmd", [], {
      onStdout: (data: string) => stdoutChunks.push(data),
      onStderr: (data: string) => stderrChunks.push(data),
    });

    expect(stdoutChunks).toEqual(["out1"]);
    expect(stderrChunks).toEqual(["err1"]);
  });

  test("exec classifies thrown errors", async () => {
    const classifyError = mock((_error: unknown, durationMs: number) => ({
      code: "TIMEOUT" as const,
      message: "timed out",
      durationMs,
    }));

    const sdk = createMockSdk({ runError: new Error("timed out") });
    const instance = createCloudInstance({
      sdk,
      classifyError,
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const result = await instance.exec("slow-cmd", [], { timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe("timed out");
    expect(classifyError).toHaveBeenCalledTimes(1);
  });

  test("exec classifies OOM errors", async () => {
    const sdk = createMockSdk({ runError: new Error("out of memory") });
    const instance = createCloudInstance({
      sdk,
      classifyError: (_error: unknown, durationMs: number) => ({
        code: "OOM" as const,
        message: "out of memory",
        durationMs,
      }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const result = await instance.exec("alloc", [], { timeoutMs: 5000 });

    expect(result.oomKilled).toBe(true);
    expect(result.stderr).toBe("out of memory");
  });

  test("exec handles truncation", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    // Mock to stream a large amount of data
    (config.sdk.commands.run as ReturnType<typeof mock>).mockImplementation(
      (_cmd: string, opts?: { onStdout?: (data: string) => void }) => {
        // Stream data to trigger accumulator
        opts?.onStdout?.("some streamed output");
        return Promise.resolve({ exitCode: 0, stdout: "fallback", stderr: "" });
      },
    );

    const result = await instance.exec("cmd", [], {});
    expect(result.stdout).toBe("some streamed output");
  });

  test("readFile returns Uint8Array", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    const content = await instance.readFile("/tmp/test.txt");

    expect(content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(content)).toBe("file content");
  });

  test("writeFile sends content", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    const content = new TextEncoder().encode("hello");
    await instance.writeFile("/tmp/out.txt", content);

    expect(config.sdk.files.write).toHaveBeenCalledWith("/tmp/out.txt", "hello");
  });

  test("destroy calls the destroy function", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.destroy();

    expect(config.destroy).toHaveBeenCalledTimes(1);
  });

  test("throws after destroy", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.destroy();

    expect(() => instance.exec("cmd", [], {})).toThrow("destroy");
  });

  test("readFile throws after destroy", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.destroy();

    expect(() => instance.readFile("/tmp/test")).toThrow("destroy");
  });

  test("writeFile throws after destroy", async () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);

    await instance.destroy();

    expect(() => instance.writeFile("/tmp/test", new Uint8Array())).toThrow("destroy");
  });
});

// ---------------------------------------------------------------------------
// spawn() tests — callback→stream bridge
// ---------------------------------------------------------------------------

function createMockProcessHandle(overrides?: {
  readonly pid?: number;
  readonly exitCode?: number;
  readonly exitError?: Error;
}): CloudSdkProcessHandle {
  const pid = overrides?.pid ?? 123;
  const exitPromise =
    overrides?.exitError !== undefined
      ? Promise.reject(overrides.exitError)
      : Promise.resolve(overrides?.exitCode ?? 0);

  return {
    pid,
    sendStdin: mock(() => undefined),
    closeStdin: mock(() => undefined),
    exited: exitPromise,
    kill: mock(() => undefined),
  };
}

function createSpawnableSdk(processHandle: CloudSdkProcessHandle): CloudSdkSandbox {
  return {
    commands: {
      run: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
      spawn: mock(
        (
          _cmd: string,
          opts?: {
            readonly onStdout?: (data: string) => void;
            readonly onStderr?: (data: string) => void;
          },
        ) => {
          // Simulate some output
          opts?.onStdout?.("hello from spawn");
          opts?.onStderr?.("spawn stderr");
          return Promise.resolve(processHandle);
        },
      ),
    },
    files: {
      read: mock(() => Promise.resolve("")),
      write: mock(() => Promise.resolve()),
    },
  };
}

describe("createCloudInstance spawn", () => {
  test("spawn is undefined when SDK has no spawn", () => {
    const config = createMockConfig();
    const instance = createCloudInstance(config);
    expect(instance.spawn).toBeUndefined();
  });

  test("spawn is defined when SDK has spawn", () => {
    const sdk = createSpawnableSdk(createMockProcessHandle());
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });
    expect(instance.spawn).toBeDefined();
  });

  test("spawn returns SandboxProcessHandle with correct fields", async () => {
    const procHandle = createMockProcessHandle({ pid: 42 });
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "node", ["server.js"]);

    expect(handle.pid).toBe(42);
    expect(handle.stdin).toBeDefined();
    expect(handle.stdout).toBeInstanceOf(ReadableStream);
    expect(handle.stderr).toBeInstanceOf(ReadableStream);
    expect(typeof handle.kill).toBe("function");
  });

  test("spawn bridges stdout callback to ReadableStream", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "echo", ["test"]);

    // Read from stdout stream — should contain the data from onStdout callback
    const reader = handle.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    expect(new TextDecoder().decode(value)).toBe("hello from spawn");
  });

  test("spawn bridges stderr callback to ReadableStream", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "cmd", []);

    const reader = handle.stderr.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    expect(new TextDecoder().decode(value)).toBe("spawn stderr");
  });

  test("spawn stdin.write delegates to SDK sendStdin", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "cat", []);

    handle.stdin.write("input data");
    expect(procHandle.sendStdin).toHaveBeenCalledWith("input data");
  });

  test("spawn stdin.write converts Uint8Array to string", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "cat", []);

    handle.stdin.write(new TextEncoder().encode("binary input"));
    expect(procHandle.sendStdin).toHaveBeenCalledWith("binary input");
  });

  test("spawn stdin.end delegates to SDK closeStdin", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const handle = await spawnOrFail(instance, "cat", []);

    handle.stdin.end();
    expect(procHandle.closeStdin).toHaveBeenCalledTimes(1);
  });

  test("spawn passes cwd and env to SDK", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    await spawnOrFail(instance, "cmd", [], {
      cwd: "/app",
      env: { NODE_ENV: "test" },
    });

    const callArgs = (sdk.commands.spawn as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      cwd: "/app",
      envs: { NODE_ENV: "test" },
    });
  });

  test("spawn throws after destroy", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    await instance.destroy();

    expect(() => spawnOrFail(instance, "cmd", [])).toThrow("destroy");
  });

  test("spawn rejects when signal is pre-aborted", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const controller = new AbortController();
    controller.abort();

    await expect(spawnOrFail(instance, "cmd", [], { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });

  test("spawn wires AbortSignal to kill", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    const controller = new AbortController();
    await spawnOrFail(instance, "cmd", [], { signal: controller.signal });

    controller.abort();
    expect(procHandle.kill).toHaveBeenCalledWith(9);
  });

  test("spawn joins command and args with shell escaping", async () => {
    const procHandle = createMockProcessHandle();
    const sdk = createSpawnableSdk(procHandle);
    const instance = createCloudInstance({
      sdk,
      classifyError: () => ({ code: "CRASH", message: "err", durationMs: 0 }),
      destroy: mock(() => Promise.resolve()),
      name: "test",
    });

    await spawnOrFail(instance, "node", ["--inspect", "app.js"]);

    const callArgs = (sdk.commands.spawn as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[0]).toBe("node --inspect app.js");
  });
});
