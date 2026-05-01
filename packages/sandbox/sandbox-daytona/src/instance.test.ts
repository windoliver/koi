import { describe, expect, test } from "bun:test";
import { createFakeSandbox } from "./__tests__/fakes.js";
import { createDaytonaInstance } from "./instance.js";

describe("createDaytonaInstance", () => {
  test("exec joins command, passes env/cwd/timeout to SDK", async () => {
    const sdk = createFakeSandbox({ runResult: { exitCode: 0, stdout: "hi", stderr: "" } });
    const instance = createDaytonaInstance(sdk);

    const result = await instance.exec("ls", ["-la", "/tmp foo"], {
      cwd: "/work",
      env: { K: "v" },
      timeoutMs: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(sdk.runCalls).toHaveLength(1);
    const [call] = sdk.runCalls;
    expect(call?.cmd).toBe("'ls' '-la' '/tmp foo'");
    expect(call?.opts?.cwd).toBe("/work");
    expect(call?.opts?.envs).toEqual({ K: "v" });
    expect(call?.opts?.timeoutMs).toBe(1000);
  });

  test("exec returns 130 immediately when signal pre-aborted", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    ac.abort();
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec maps SDK errors to non-zero result", async () => {
    const sdk = createFakeSandbox({ runError: new Error("boom") });
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  test("exec flags timedOut when SDK error message mentions timeout", async () => {
    const sdk = createFakeSandbox({ runError: new Error("timed out") });
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.timedOut).toBe(true);
  });

  test("readFile / writeFile round-trip via SDK", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.writeFile("/a", new TextEncoder().encode("payload"));
    const bytes = await instance.readFile("/a");
    expect(new TextDecoder().decode(bytes)).toBe("payload");
  });

  test("destroy closes SDK and is idempotent", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    await instance.destroy();
    expect(sdk.closed()).toBe(true);
  });

  test("operations after destroy throw", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    await expect(instance.exec("ls", [])).rejects.toThrow(/destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/destroyed/);
  });

  test("exec quotes shell metacharacters in the command name (not just args)", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.exec("/bin/with space; rm -rf /", []);
    expect(sdk.runCalls[0]?.cmd).toBe("'/bin/with space; rm -rf /'");
  });

  test("exec forwards AbortSignal to SDK opts", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    await instance.exec("ls", [], { signal: ac.signal });
    expect(sdk.runCalls[0]?.opts?.signal).toBe(ac.signal);
  });

  test("exec resolves promptly with exit 130 when aborted mid-flight", async () => {
    let resolveRun!: (v: { exitCode: number; stdout: string; stderr: string }) => void;
    const sdk = createFakeSandbox({
      runImpl: () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    });
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    const p = instance.exec("ls", [], { signal: ac.signal });
    queueMicrotask(() => ac.abort());
    const result = await p;
    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    resolveRun({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("destroy stays retryable after a transient SDK failure", async () => {
    let attempts = 0;
    const sdk = createFakeSandbox({
      closeImpl: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient network blip");
      },
    });
    const instance = createDaytonaInstance(sdk);
    await expect(instance.destroy()).rejects.toThrow(/transient/);
    expect(sdk.closed()).toBe(false);
    await instance.destroy();
    expect(sdk.closed()).toBe(true);
    expect(attempts).toBe(2);
  });

  test("exec rejects stdin when SDK does not advertise supportsStdin", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await expect(instance.exec("cat", [], { stdin: "hello" })).rejects.toThrow(/supportsStdin/);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec forwards stdin when SDK advertises supportsStdin", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsStdin: true } };
    const instance = createDaytonaInstance(sdk);
    await instance.exec("cat", [], { stdin: "payload" });
    expect(base.runCalls[0]?.opts?.stdin).toBe("payload");
  });

  test("exec rejects maxOutputBytes when SDK does not advertise support", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await expect(instance.exec("ls", [], { maxOutputBytes: 1024 })).rejects.toThrow(
      /supportsMaxOutputBytes/,
    );
  });

  test("exec surfaces SDK truncated flag when present", async () => {
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsMaxOutputBytes: true,
        run: async (): Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
          truncated?: boolean;
        }> => ({ exitCode: 0, stdout: "x", stderr: "", truncated: true }),
      },
    };
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", [], { maxOutputBytes: 10 });
    expect(result.truncated).toBe(true);
  });

  test("readFile rejects when SDK exposes no readBytes (no text-only fallback)", async () => {
    const base = createFakeSandbox({ initialFiles: new Map([["/a", "hi"]]) });
    const sdk = {
      ...base,
      files: { read: base.files.read, write: base.files.write },
    };
    const instance = createDaytonaInstance(sdk);
    await expect(instance.readFile("/a")).rejects.toThrow(/readBytes/);
  });

  test("operations during destroyPending reject", async () => {
    let release!: () => void;
    const sdk = createFakeSandbox({
      closeImpl: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const instance = createDaytonaInstance(sdk);
    const destroyPromise = instance.destroy();
    await expect(instance.exec("ls", [])).rejects.toThrow(/being destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/being destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/being destroyed/);
    release();
    await destroyPromise;
  });

  test("readFile prefers SDK readBytes when available (binary-safe)", async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    const sdk = {
      ...createFakeSandbox(),
      files: {
        read: async (): Promise<string> => {
          throw new Error("should not be called");
        },
        write: async (): Promise<void> => undefined,
        readBytes: async (): Promise<Uint8Array> => bytes,
      },
    };
    const instance = createDaytonaInstance(sdk);
    expect(await instance.readFile("/bin")).toEqual(bytes);
  });

  test("writeFile prefers SDK writeBytes when available (binary-safe)", async () => {
    const captured: { bytes?: Uint8Array } = {};
    const sdk = {
      ...createFakeSandbox(),
      files: {
        read: async (): Promise<string> => "",
        write: async (): Promise<void> => {
          throw new Error("should not be called");
        },
        writeBytes: async (_path: string, content: Uint8Array): Promise<void> => {
          captured.bytes = content;
        },
      },
    };
    const instance = createDaytonaInstance(sdk);
    const payload = new Uint8Array([0xff, 0x00, 0xfe]);
    await instance.writeFile("/bin", payload);
    expect(captured.bytes).toEqual(payload);
  });

  test("writeFile rejects non-UTF-8 bytes when SDK is text-only (fail closed)", async () => {
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      files: { read: base.files.read, write: base.files.write },
    };
    const instance = createDaytonaInstance(sdk);
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    await expect(instance.writeFile("/x", invalidUtf8)).rejects.toThrow(/non-UTF-8/);
    expect(base.files.store.has("/x")).toBe(false);
  });

  test("concurrent destroy calls coalesce onto one SDK teardown", async () => {
    let calls = 0;
    const sdk = createFakeSandbox({
      closeImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const instance = createDaytonaInstance(sdk);
    await Promise.all([instance.destroy(), instance.destroy(), instance.destroy()]);
    expect(calls).toBe(1);
  });
});
