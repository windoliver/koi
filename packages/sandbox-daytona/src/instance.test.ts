import { describe, expect, mock, test } from "bun:test";
import { createDaytonaInstance } from "./instance.js";
import type { DaytonaSdkSandbox } from "./types.js";

function createMockSdk(overrides?: Partial<DaytonaSdkSandbox>): DaytonaSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "output", stderr: "" })) },
    files: {
      read: mock(() => Promise.resolve("file content")),
      write: mock(() => Promise.resolve()),
    },
    close: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("createDaytonaInstance", () => {
  test("exec runs command and returns result", async () => {
    const sdk = createMockSdk();
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
    await instance.destroy();
  });

  test("exec handles timeout errors", async () => {
    const sdk = createMockSdk({
      commands: { run: mock(() => Promise.reject(new Error("Request timeout"))) },
    });
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("sleep", ["100"]);
    expect(result.timedOut).toBe(true);
    await instance.destroy();
  });

  test("readFile returns Uint8Array", async () => {
    const sdk = createMockSdk();
    const instance = createDaytonaInstance(sdk);
    const content = await instance.readFile("/test.txt");
    expect(new TextDecoder().decode(content)).toBe("file content");
    await instance.destroy();
  });

  test("writeFile sends content", async () => {
    const sdk = createMockSdk();
    const instance = createDaytonaInstance(sdk);
    await instance.writeFile("/test.txt", new TextEncoder().encode("hello"));
    expect(sdk.files.write).toHaveBeenCalledWith("/test.txt", "hello");
    await instance.destroy();
  });

  test("destroy calls sdk.close", async () => {
    const sdk = createMockSdk();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });

  test("throws after destroy", async () => {
    const sdk = createMockSdk();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    expect(() => instance.exec("cmd", [])).toThrow("daytona: cannot call exec() after destroy()");
  });

  test("streaming callbacks are invoked", async () => {
    const chunks: string[] = [];
    const runFn = mock(async (_cmd: string, opts?: { onStdout?: (d: string) => void }) => {
      opts?.onStdout?.("data");
      return { exitCode: 0, stdout: "data", stderr: "" };
    });
    const sdk = createMockSdk({ commands: { run: runFn } });
    const instance = createDaytonaInstance(sdk);
    await instance.exec("cmd", [], { onStdout: (c) => chunks.push(c) });
    expect(chunks).toEqual(["data"]);
    await instance.destroy();
  });
});
