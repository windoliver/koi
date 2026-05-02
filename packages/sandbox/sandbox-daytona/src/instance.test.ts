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

  test("exec preserves successful SDK result when abort fires after completion", async () => {
    // Race regression: a late abort (after the SDK has already resolved with
    // success) must NOT rewrite the exit code to 130. Mapping a finished
    // command to 130 would tell the caller their side-effecting command was
    // cancelled, encouraging duplicate-execution retries.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (): Promise<import("./types.js").DaytonaRunResult> => ({
          exitCode: 0,
          stdout: "done",
          stderr: "",
        }),
      },
    };
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    const promise = instance.exec("ls", [], { signal: ac.signal });
    queueMicrotask(() => ac.abort());
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
  });

  test("exec short-circuits with exit 130 when signal is pre-aborted (no SDK call)", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsAbort: true } };
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    ac.abort();
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(base.runCalls).toHaveLength(0);
  });

  test("exec truncates multibyte UTF-8 output without replacement-char inflation", async () => {
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsMaxOutputBytes: true,
        run: async (): Promise<import("./types.js").DaytonaRunResult> => ({
          exitCode: 0,
          stdout: "🌊🌊🌊🌊",
          stderr: "",
        }),
      },
    };
    const instance = createDaytonaInstance(sdk);
    for (const cap of [1, 2, 3, 5, 7]) {
      const result = await instance.exec("ls", [], { maxOutputBytes: cap });
      expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(cap);
      expect(result.stdout.includes("�")).toBe(false);
      expect(result.truncated).toBe(true);
    }
  });

  test("exec returns 130 when SDK rejects on abort (not generic exit 1)", async () => {
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (
          _cmd: string,
          opts?: import("./types.js").DaytonaRunOpts,
        ): Promise<import("./types.js").DaytonaRunResult> => {
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          const err = new Error("operation aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    };
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
  });

  test("exec maps exit 124 to timedOut and 137 to oomKilled", async () => {
    const base = createFakeSandbox();
    function makeSdk(code: number): typeof base {
      return {
        ...base,
        commands: {
          ...base.commands,
          run: async (): Promise<import("./types.js").DaytonaRunResult> => ({
            exitCode: code,
            stdout: "",
            stderr: "",
          }),
        },
      };
    }
    const t = await createDaytonaInstance(makeSdk(124)).exec("ls", []);
    const o = await createDaytonaInstance(makeSdk(137)).exec("ls", []);
    expect(t.timedOut).toBe(true);
    expect(t.oomKilled).toBe(false);
    expect(o.timedOut).toBe(false);
    expect(o.oomKilled).toBe(true);
  });

  test("exec rejects fail-closed when signal provided but SDK has no supportsAbort", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    await expect(instance.exec("ls", [], { signal: ac.signal })).rejects.toThrow(/supportsAbort/);
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

  test("destroy deletes the workspace via sdk.delete and is idempotent", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    await instance.destroy();
    expect(sdk.deleted()).toBe(true);
    expect(sdk.closed()).toBe(false);
  });

  test("destroy() bounded — never hangs forever on stalled sdk.delete()", async () => {
    let deleteAttempts = 0;
    const sdk = createFakeSandbox({
      deleteImpl: async () => {
        deleteAttempts++;
        if (deleteAttempts === 1) return new Promise<void>(() => {});
      },
    });
    const instance = createDaytonaInstance(sdk);
    const start = performance.now();
    await expect(instance.destroy()).rejects.toThrow(/timed out.*quarantined/i);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(15_000);
    await expect(instance.exec("ls", [])).rejects.toThrow(/quarantined/);
    await instance.destroy();
    expect(deleteAttempts).toBe(2);
  }, 20_000);

  test("destroy runtime-guards against JS callers that pass an SDK without delete()", async () => {
    // The DaytonaSdkSandbox type now requires delete(), so well-typed code
    // cannot reach this branch. The runtime guard remains as defence in
    // depth for JS callers (or wrappers that lie about their shape).
    const base = createFakeSandbox();
    const { delete: _omit, ...stripped } = base;
    // @ts-expect-error -- intentionally violating the type contract to exercise the runtime guard
    const instance = createDaytonaInstance(stripped);
    await expect(instance.destroy()).rejects.toThrow(/sdk\.delete/);
    expect(base.closed()).toBe(false);
    // Instance must not be marked destroyed; subsequent ops remain usable.
    await instance.exec("ls", []);
    expect(base.runCalls).toHaveLength(1);
  });

  test("destroy preserves the SDK `this` receiver (real SDK objects rely on it)", async () => {
    // Regression: `const fn = sdk.delete; await fn();` would lose the
    // receiver and break any real SDK that uses `this` inside delete().
    const base = createFakeSandbox();
    let observed: unknown;
    const sdk = {
      ...base,
      marker: "daytona-handle",
      delete: function (this: { marker: string }): Promise<void> {
        observed = this.marker;
        return Promise.resolve();
      },
    };
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    expect(observed).toBe("daytona-handle");
  });

  test("exec catches abort that fires between pre-check and listener attach", async () => {
    // Race window regression: the signal could become aborted between
    // the pre-check and addEventListener. addEventListener does not
    // replay past abort events, so without a synchronous post-attach
    // `aborted` re-check the signal would be silently lost.
    const base = createFakeSandbox();
    const ac = new AbortController();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: (
          _cmd: string,
          _opts?: import("./types.js").DaytonaRunOpts,
        ): Promise<import("./types.js").DaytonaRunResult> => {
          ac.abort();
          return Promise.resolve({ exitCode: 0, stdout: "ignored-cancel", stderr: "" });
        },
      },
    };
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(0);
  });

  test("destroy converges to destroyed when SDK succeeds after local timeout", async () => {
    // Slow-provider regression: a teardown that lands at 11s still
    // succeeded — the remote workspace is gone. The first destroy()
    // surfaces the timeout error; the late SDK success flips state so
    // a second destroy() is a no-op (no double delete, no leak alarm).
    const base = createFakeSandbox();
    let deleteCalls = 0;
    const sdk = {
      ...base,
      delete: () => {
        deleteCalls++;
        return new Promise<void>((resolve) => setTimeout(resolve, 11_000));
      },
    };
    const instance = createDaytonaInstance(sdk);
    const first = instance.destroy().catch((e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 11_500));
    const firstError = await first;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toMatch(/timed out/i);
    await instance.destroy();
    expect(deleteCalls).toBe(1);
  }, 20_000);

  test("exec propagates SDK success (not 130) when abort wins race but command actually completed", async () => {
    // Race-window regression: caller aborts at the very moment the remote
    // command finishes successfully. The signal beats the SDK resolution
    // into the Promise.race, but the SDK then settles with exit 0 — proof
    // the command actually ran to completion. Mapping that to 130 would
    // tell higher layers the work was cancelled, when in reality the side
    // effects already happened. Replays would duplicate them.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (
          _cmd: string,
          opts?: import("./types.js").DaytonaRunOpts,
        ): Promise<import("./types.js").DaytonaRunResult> => {
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    };
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("exec returns failure (not 130) when SDK rejects with AbortError but caller never aborted", async () => {
    // Server-side eviction / transport-layer aborts can surface as
    // AbortError-shaped rejections. Mapping those to exit 130 without a
    // matching caller abort would tell higher layers the run was
    // intentionally cancelled, breaking retry-safety.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        run: async (): Promise<import("./types.js").DaytonaRunResult> => {
          const err = new Error("workspace evicted");
          err.name = "AbortError";
          throw err;
        },
      },
    };
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("workspace evicted");
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

  test("exec forwards AbortSignal to SDK opts when supportsAbort is true", async () => {
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsAbort: true } };
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    await instance.exec("ls", [], { signal: ac.signal });
    expect(base.runCalls[0]?.opts?.signal).toBe(ac.signal);
  });

  test("destroy stays retryable after a transient SDK failure", async () => {
    let attempts = 0;
    const sdk = createFakeSandbox({
      deleteImpl: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient network blip");
      },
    });
    const instance = createDaytonaInstance(sdk);
    await expect(instance.destroy()).rejects.toThrow(/transient/);
    expect(sdk.deleted()).toBe(false);
    await instance.destroy();
    expect(sdk.deleted()).toBe(true);
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

  test("exec rejects malformed maxOutputBytes (negative, NaN, Infinity, fractional)", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    for (const bad of [-1, -1_000, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      await expect(instance.exec("ls", [], { maxOutputBytes: bad })).rejects.toThrow(
        /non-negative integer/,
      );
    }
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec rejects fail-closed when SDK does not advertise supportsMaxOutputBytes", async () => {
    // The 1 MB default cap from SandboxExecOptions cannot be honoured
    // post-buffer; without server-side enforcement the adapter refuses.
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsMaxOutputBytes: false } };
    const instance = createDaytonaInstance(sdk);
    await expect(instance.exec("ls", [])).rejects.toThrow(/supportsMaxOutputBytes/);
  });

  test("exec forwards the contract default 1 MB cap when caller omits maxOutputBytes", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.exec("ls", []);
    expect(sdk.runCalls[0]?.opts?.maxOutputBytes).toBe(1_000_000);
  });

  test("exec enforces a combined byte budget across stdout and stderr", async () => {
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsMaxOutputBytes: true,
        run: async (): Promise<import("./types.js").DaytonaRunResult> => ({
          exitCode: 0,
          stdout: "a".repeat(800),
          stderr: "b".repeat(800),
        }),
      },
    };
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", [], { maxOutputBytes: 1024 });
    expect(result.stdout.length).toBe(800);
    expect(result.stderr.length).toBe(224);
    expect(result.truncated).toBe(true);
  });

  test("exec defensively re-trims oversized SDK output to the contract default cap", async () => {
    // The cap is forwarded server-side; the adapter also re-trims locally
    // as a defensive measure for SDKs whose enforcement is approximate.
    const big = "a".repeat(1_500_000);
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
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.stdout.length).toBe(1_000_000);
    expect(result.truncated).toBe(true);
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
      deleteImpl: () =>
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
      deleteImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const instance = createDaytonaInstance(sdk);
    await Promise.all([instance.destroy(), instance.destroy(), instance.destroy()]);
    expect(calls).toBe(1);
  });
});
