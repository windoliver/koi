import { describe, expect, mock, test } from "bun:test";
import { createE2bInstance } from "./instance.js";
import type { E2bSdkSandbox } from "./types.js";

function createMockSdk(overrides?: Partial<E2bSdkSandbox>): E2bSdkSandbox {
  return {
    commands: {
      run: mock(() => Promise.resolve({ exitCode: 0, stdout: "output", stderr: "" })),
    },
    files: {
      read: mock(() => Promise.resolve("file content")),
      write: mock(() => Promise.resolve()),
    },
    kill: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("createE2bInstance", () => {
  test("exec runs command and returns result", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    const result = await instance.exec("echo", ["hello"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(sdk.commands.run).toHaveBeenCalled();

    await instance.destroy();
  });

  test("exec passes options to SDK", async () => {
    const runFn = mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    const sdk = createMockSdk({ commands: { run: runFn } });
    const instance = createE2bInstance(sdk);

    await instance.exec("ls", ["-la"], {
      cwd: "/tmp",
      env: { FOO: "bar" },
      timeoutMs: 5000,
    });

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(runFn).toHaveBeenCalledWith(
      "ls -la",
      expect.objectContaining({
        cwd: "/tmp",
        envs: { FOO: "bar" },
        timeoutMs: 5000,
      }),
    );

    await instance.destroy();
  });

  test("exec calls streaming callbacks", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const runFn = mock(
      async (
        _cmd: string,
        opts?: {
          onStdout?: (d: string) => void;
          onStderr?: (d: string) => void;
        },
      ) => {
        opts?.onStdout?.("chunk1");
        opts?.onStdout?.("chunk2");
        opts?.onStderr?.("err1");
        return { exitCode: 0, stdout: "chunk1chunk2", stderr: "err1" };
      },
    );

    const sdk = createMockSdk({ commands: { run: runFn } });
    const instance = createE2bInstance(sdk);

    await instance.exec("cmd", [], {
      onStdout: (c) => stdoutChunks.push(c),
      onStderr: (c) => stderrChunks.push(c),
    });

    expect(stdoutChunks).toEqual(["chunk1", "chunk2"]);
    expect(stderrChunks).toEqual(["err1"]);

    await instance.destroy();
  });

  test("exec handles timeout errors", async () => {
    const sdk = createMockSdk({
      commands: {
        run: mock(() => Promise.reject(new Error("Request timeout"))),
      },
    });
    const instance = createE2bInstance(sdk);

    const result = await instance.exec("sleep", ["100"]);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);

    await instance.destroy();
  });

  test("exec handles OOM errors", async () => {
    const sdk = createMockSdk({
      commands: {
        run: mock(() => Promise.reject(new Error("Out of memory"))),
      },
    });
    const instance = createE2bInstance(sdk);

    const result = await instance.exec("alloc", []);
    expect(result.oomKilled).toBe(true);

    await instance.destroy();
  });

  test("readFile returns file content as Uint8Array", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    const content = await instance.readFile("/test.txt");
    expect(new TextDecoder().decode(content)).toBe("file content");

    await instance.destroy();
  });

  test("writeFile sends content to SDK", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    await instance.writeFile("/test.txt", new TextEncoder().encode("hello"));
    expect(sdk.files.write).toHaveBeenCalledWith("/test.txt", "hello");

    await instance.destroy();
  });

  test("destroy calls sdk.kill", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    await instance.destroy();
    expect(sdk.kill).toHaveBeenCalledTimes(1);
  });

  test("throws after destroy for exec", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    await instance.destroy();
    expect(() => instance.exec("cmd", [])).toThrow("e2b: cannot call exec() after destroy()");
  });

  test("throws after destroy for readFile", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    await instance.destroy();
    expect(() => instance.readFile("/test")).toThrow("e2b: cannot call readFile() after destroy()");
  });

  test("throws after destroy for writeFile", async () => {
    const sdk = createMockSdk();
    const instance = createE2bInstance(sdk);

    await instance.destroy();
    expect(() => instance.writeFile("/test", new Uint8Array())).toThrow(
      "e2b: cannot call writeFile() after destroy()",
    );
  });
});
