import { describe, expect, test } from "bun:test";
import { createFakeSandbox } from "./__tests__/fakes.js";
import { createE2bInstance } from "./instance.js";

describe("createE2bInstance", () => {
  test("exec joins command and args, passes env/cwd/timeout to SDK", async () => {
    const sdk = createFakeSandbox({
      runResult: { exitCode: 0, stdout: "hi\n", stderr: "" },
    });
    const instance = createE2bInstance(sdk);

    const result = await instance.exec("echo", ["hello world", "x"], {
      cwd: "/work",
      env: { FOO: "bar" },
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(sdk.runCalls).toHaveLength(1);
    const [call] = sdk.runCalls;
    expect(call?.cmd).toBe("'echo' 'hello world' 'x'");
    expect(call?.opts?.cwd).toBe("/work");
    expect(call?.opts?.envs).toEqual({ FOO: "bar" });
    expect(call?.opts?.timeoutMs).toBe(5000);
  });

  test("exec invokes caller streaming callbacks for SDK chunks", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        run: async (
          _cmd: string,
          opts?: import("./types.js").E2bRunOpts,
        ): Promise<import("./types.js").E2bRunResult> => {
          opts?.onStdout?.("hello ");
          opts?.onStdout?.("world");
          opts?.onStderr?.("warn");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", [], {
      onStdout: (d) => stdoutChunks.push(d),
      onStderr: (d) => stderrChunks.push(d),
    });
    expect(stdoutChunks).toEqual(["hello ", "world"]);
    expect(stderrChunks).toEqual(["warn"]);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
  });

  test("exec returns exitCode 130 when SDK observes the abort", async () => {
    // SDK must advertise supportsAbort and is contracted to settle only after
    // the remote command is killed.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (
          _cmd: string,
          opts?: import("./types.js").E2bRunOpts,
        ): Promise<import("./types.js").E2bRunResult> => {
          // Wait until the signal fires before resolving — simulates a kill.
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted === true) resolve();
            else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { exitCode: 137, stdout: "", stderr: "" };
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const result = await instance.exec("echo", ["hi"], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
  });

  test("exec short-circuits with exit 130 when signal is pre-aborted (no SDK call)", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsAbort: true } };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    ac.abort();
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(base.runCalls).toHaveLength(0);
  });

  test("exec rejects fail-closed when signal provided but SDK has no supportsAbort", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    await expect(instance.exec("ls", [], { signal: ac.signal })).rejects.toThrow(/supportsAbort/);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec maps SDK errors to non-zero result with stderr message", async () => {
    const sdk = createFakeSandbox({ runError: new Error("boom") });
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  test("exec flags timedOut when SDK error message mentions timeout", async () => {
    const sdk = createFakeSandbox({ runError: new Error("operation timed out") });
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.timedOut).toBe(true);
  });

  test("readFile decodes string to bytes", async () => {
    const sdk = createFakeSandbox({ initialFiles: new Map([["/a", "hello"]]) });
    const instance = createE2bInstance(sdk);
    const bytes = await instance.readFile("/a");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  test("writeFile encodes bytes to string and stores via SDK", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.writeFile("/b", new TextEncoder().encode("payload"));
    expect(sdk.files.store.get("/b")).toBe("payload");
  });

  test("destroy calls SDK kill and is idempotent", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.destroy();
    await instance.destroy();
    expect(sdk.killed()).toBe(true);
  });

  test("exec/readFile/writeFile after destroy throw", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.destroy();
    await expect(instance.exec("ls", [])).rejects.toThrow(/destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/destroyed/);
  });

  test("exec quotes shell metacharacters in the command name (not just args)", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.exec("/bin/with space; rm -rf /", []);
    expect(sdk.runCalls[0]?.cmd).toBe("'/bin/with space; rm -rf /'");
  });

  test("exec forwards AbortSignal to SDK opts when supportsAbort is true", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsAbort: true } };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    await instance.exec("ls", [], { signal: ac.signal });
    expect(base.runCalls[0]?.opts?.signal).toBe(ac.signal);
  });

  test("destroy stays retryable after a transient SDK failure", async () => {
    let attempts = 0;
    const sdk = createFakeSandbox({
      killImpl: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient network blip");
      },
    });
    const instance = createE2bInstance(sdk);
    await expect(instance.destroy()).rejects.toThrow(/transient/);
    expect(sdk.killed()).toBe(false);
    // Second attempt succeeds — instance must not be locally marked destroyed yet.
    await instance.destroy();
    expect(sdk.killed()).toBe(true);
    expect(attempts).toBe(2);
  });

  test("exec rejects stdin when SDK does not advertise supportsStdin", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await expect(instance.exec("cat", [], { stdin: "hello" })).rejects.toThrow(/supportsStdin/);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec forwards stdin when SDK advertises supportsStdin", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsStdin: true } };
    const instance = createE2bInstance(sdk);
    await instance.exec("cat", [], { stdin: "payload" });
    expect(base.runCalls[0]?.opts?.stdin).toBe("payload");
  });

  test("exec rejects maxOutputBytes when SDK does not advertise support", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await expect(instance.exec("ls", [], { maxOutputBytes: 1024 })).rejects.toThrow(
      /supportsMaxOutputBytes/,
    );
  });

  test("exec applies the contract default 1MB cap when SDK supports maxOutputBytes", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsMaxOutputBytes: true } };
    const instance = createE2bInstance(sdk);
    await instance.exec("ls", []);
    // Caller didn't ask — we still forward 1MB so noisy commands don't blow up bandwidth.
    expect(base.runCalls[0]?.opts?.maxOutputBytes).toBe(1_000_000);
  });

  test("exec enforces a combined byte budget across stdout and stderr", async () => {
    // Caller asks for 1024 bytes total; SDK emits 800 to stdout then 800 to stderr.
    // Combined cap means stderr must be truncated to fit the remaining 224 bytes.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsMaxOutputBytes: true,
        run: async (
          _cmd: string,
          opts?: import("./types.js").E2bRunOpts,
        ): Promise<import("./types.js").E2bRunResult> => {
          opts?.onStdout?.("a".repeat(800));
          opts?.onStderr?.("b".repeat(800));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", [], { maxOutputBytes: 1024 });
    expect(result.stdout.length).toBe(800);
    expect(result.stderr.length).toBe(224);
    expect(result.truncated).toBe(true);
  });

  test("exec truncates multibyte UTF-8 output at the byte boundary (no replacement-char inflation)", async () => {
    // 4 wave emoji = 4 bytes each in UTF-8 (16 bytes). Cap at 1 byte: trimming
    // must drop the partial codepoint entirely (returning ""), not insert
    // U+FFFD which would re-inflate to 3 bytes.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsMaxOutputBytes: true,
        run: async (): Promise<import("./types.js").E2bRunResult> => ({
          exitCode: 0,
          stdout: "🌊🌊🌊🌊",
          stderr: "",
        }),
      },
    };
    const instance = createE2bInstance(sdk);
    for (const cap of [1, 2, 3, 5, 7]) {
      const result = await instance.exec("ls", [], { maxOutputBytes: cap });
      const outBytes = new TextEncoder().encode(result.stdout).byteLength;
      // Byte-accurate budget: must NEVER exceed the cap, even with multibyte cuts.
      expect(outBytes).toBeLessThanOrEqual(cap);
      // U+FFFD (3 bytes) must not appear from truncation.
      expect(result.stdout.includes("�")).toBe(false);
      expect(result.truncated).toBe(true);
    }
  });

  test("exec truncates oversized SDK output locally and reports truncated=true", async () => {
    const big = "a".repeat(1_500_000); // 1.5 MB > 1 MB default cap
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        run: async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
          exitCode: 0,
          stdout: big,
          stderr: "",
        }),
      },
    };
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1_000_000);
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
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", [], { maxOutputBytes: 10 });
    expect(result.truncated).toBe(true);
  });

  test("readFile rejects when SDK exposes no readBytes (no text-only fallback)", async () => {
    const base = createFakeSandbox({ initialFiles: new Map([["/a", "hi"]]) });
    // Strip readBytes from the fake to simulate a text-only SDK.
    const sdk = {
      ...base,
      files: {
        read: base.files.read,
        write: base.files.write,
      },
    };
    const instance = createE2bInstance(sdk);
    await expect(instance.exec).toBeDefined();
    await expect(instance.readFile("/a")).rejects.toThrow(/readBytes/);
  });

  test("operations during destroyPending reject", async () => {
    let releaseKill!: () => void;
    const sdk = createFakeSandbox({
      killImpl: () =>
        new Promise<void>((resolve) => {
          releaseKill = resolve;
        }),
    });
    const instance = createE2bInstance(sdk);
    const destroyPromise = instance.destroy();
    // teardown is in flight — concurrent ops must be refused
    await expect(instance.exec("ls", [])).rejects.toThrow(/being destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/being destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/being destroyed/);
    releaseKill();
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
        readBytes: async (path: string): Promise<Uint8Array> => {
          expect(path).toBe("/bin");
          return bytes;
        },
      },
    };
    const instance = createE2bInstance(sdk);
    expect(await instance.readFile("/bin")).toEqual(bytes);
  });

  test("writeFile prefers SDK writeBytes when available (binary-safe)", async () => {
    const captured: { path?: string; bytes?: Uint8Array } = {};
    const sdk = {
      ...createFakeSandbox(),
      files: {
        read: async (): Promise<string> => "",
        write: async (): Promise<void> => {
          throw new Error("should not be called");
        },
        writeBytes: async (path: string, content: Uint8Array): Promise<void> => {
          captured.path = path;
          captured.bytes = content;
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const payload = new Uint8Array([0xff, 0x00, 0xfe]);
    await instance.writeFile("/bin", payload);
    expect(captured.path).toBe("/bin");
    expect(captured.bytes).toEqual(payload);
  });

  test("writeFile rejects non-UTF-8 bytes when SDK is text-only (fail closed)", async () => {
    const base = createFakeSandbox();
    // Strip the binary methods so the adapter takes the text-only fallback.
    const sdk = {
      ...base,
      files: { read: base.files.read, write: base.files.write },
    };
    const instance = createE2bInstance(sdk);
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    await expect(instance.writeFile("/x", invalidUtf8)).rejects.toThrow(/non-UTF-8/);
    expect(base.files.store.has("/x")).toBe(false);
  });

  test("concurrent destroy calls coalesce onto one SDK teardown", async () => {
    let calls = 0;
    const sdk = createFakeSandbox({
      killImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const instance = createE2bInstance(sdk);
    await Promise.all([instance.destroy(), instance.destroy(), instance.destroy()]);
    expect(calls).toBe(1);
  });
});
