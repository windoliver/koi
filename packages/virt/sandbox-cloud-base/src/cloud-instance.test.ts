import { describe, expect, mock, test } from "bun:test";
import type { CloudInstanceConfig, CloudSdkSandbox } from "./cloud-instance.js";
import { createCloudInstance } from "./cloud-instance.js";

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
