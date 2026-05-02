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
          // SDK final strings are authoritative; streaming chunks are advisory.
          return { exitCode: 0, stdout: "hello world", stderr: "warn" };
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

  test("exec preserves successful SDK result when abort fires after completion", async () => {
    // Race regression: if the SDK has already resolved successfully and *then*
    // the caller aborts, we MUST report the real exit code. Mapping a finished
    // command to 130 would tell the caller their side-effecting command was
    // cancelled — encouraging a duplicate retry of work that already ran.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (): Promise<import("./types.js").E2bRunResult> => ({
          exitCode: 0,
          stdout: "done",
          stderr: "",
        }),
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    const promise = instance.exec("echo", ["hi"], { signal: ac.signal });
    // Abort after the SDK promise has already resolved — the adapter must
    // ignore this late abort and keep the real exit code.
    queueMicrotask(() => ac.abort());
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
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

  test("exec returns 130 when SDK rejects on abort (not generic exit 1)", async () => {
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
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          const err = new Error("operation aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
  });

  test("exec quarantines instance when SDK never confirms post-abort termination", async () => {
    // Hung provider regression: when the SDK never settles after abort
    // the adapter must NOT report exit 130 — that signals a clean cancel
    // and would invite higher-layer retry logic to replay a command that
    // may still be running remotely. Surface exit 1 (indeterminate) plus
    // a clear stderr warning, and quarantine the instance.
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (): Promise<import("./types.js").E2bRunResult> => {
          return new Promise<import("./types.js").E2bRunResult>(() => {});
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const start = performance.now();
    const result = await instance.exec("sleep", ["999"], { signal: ac.signal });
    const elapsed = performance.now() - start;
    // Indeterminate failure — NOT 130, so callers don't replay.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/INDETERMINATE/);
    expect(result.stderr).toMatch(/abort timeout/i);
    expect(elapsed).toBeLessThan(10_000);
    await expect(instance.exec("ls", [])).rejects.toThrow(/quarantined/);
    await instance.destroy();
  }, 15_000);

  test("destroy() bounded — never hangs forever on stalled sdk.kill()", async () => {
    // Regression: an unbounded destroyPending wedges every subsequent op
    // and gives callers no retry path. The adapter must time out and
    // transition to quarantine, then allow a retry.
    const base = createFakeSandbox();
    let killAttempts = 0;
    const sdk = {
      ...base,
      kill: async (): Promise<void> => {
        killAttempts++;
        if (killAttempts === 1) {
          // First call hangs forever.
          return new Promise<void>(() => {});
        }
        // Second call succeeds (provider recovered).
      },
    };
    const instance = createE2bInstance(sdk);
    const start = performance.now();
    await expect(instance.destroy()).rejects.toThrow(/timed out.*quarantined/i);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(15_000);
    // Quarantined: ops reject.
    await expect(instance.exec("ls", [])).rejects.toThrow(/quarantined/);
    // But destroy() can be retried — and this time the SDK responds.
    await instance.destroy();
    expect(killAttempts).toBe(2);
  }, 20_000);

  test("quarantined instance still allows destroy() to attempt teardown", async () => {
    // Regression: quarantine must not foreclose the only programmatic
    // teardown path; setting destroyed=true would make destroy() a no-op
    // and strand the billable remote sandbox.
    let killCalled = false;
    const base = createFakeSandbox();
    const sdk = {
      ...base,
      kill: async (): Promise<void> => {
        killCalled = true;
      },
      commands: {
        ...base.commands,
        supportsAbort: true,
        run: async (): Promise<import("./types.js").E2bRunResult> =>
          new Promise<import("./types.js").E2bRunResult>(() => {}),
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    await instance.exec("sleep", ["999"], { signal: ac.signal });
    // Now quarantined. destroy() must still call sdk.kill().
    await instance.destroy();
    expect(killCalled).toBe(true);
  }, 15_000);

  test("exec returns 130 when caller aborts mid-flight, regardless of how the SDK surfaces it", async () => {
    // Provider SDKs are not required to throw AbortError on cancellation —
    // a conforming wrapper can resolve with a kill exit code (137/143) or
    // even reject with a non-AbortError after a confirmed kill. As long as
    // the caller's signal aborted during the call, we normalize to 130 so
    // higher layers see consistent cancellation semantics.
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
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // SDK resolves with exit 137 (SIGKILL) — no AbortError thrown.
          return { exitCode: 137, stdout: "", stderr: "" };
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
  });

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
          opts?: import("./types.js").E2bRunOpts,
        ): Promise<import("./types.js").E2bRunResult> => {
          // Wait for the abort signal, then resolve with success — the
          // SDK had already finished by the time it noticed the abort.
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    };
    const instance = createE2bInstance(sdk);
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
        run: async (): Promise<import("./types.js").E2bRunResult> => {
          const err = new Error("microvm evicted by provider");
          err.name = "AbortError";
          throw err;
        },
      },
    };
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("microvm evicted");
  });

  test("exec maps exit 124 to timedOut and 137 to oomKilled (Docker-aligned)", async () => {
    const base = createFakeSandbox();
    function makeSdk(code: number): typeof base {
      return {
        ...base,
        commands: {
          ...base.commands,
          run: async (): Promise<import("./types.js").E2bRunResult> => ({
            exitCode: code,
            stdout: "",
            stderr: "",
          }),
        },
      };
    }
    const t = await createE2bInstance(makeSdk(124)).exec("ls", []);
    const o = await createE2bInstance(makeSdk(137)).exec("ls", []);
    expect(t.timedOut).toBe(true);
    expect(t.oomKilled).toBe(false);
    expect(o.timedOut).toBe(false);
    expect(o.oomKilled).toBe(true);
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

  test("exec rejects malformed maxOutputBytes (negative, NaN, Infinity, fractional)", async () => {
    // A negative cap would make Uint8Array.slice(0, -1) keep almost the
    // entire buffer; NaN/Infinity skip the byte comparison; fractional
    // values are ambiguous. All must fail-closed before dispatch.
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    for (const bad of [-1, -1_000, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      await expect(instance.exec("ls", [], { maxOutputBytes: bad })).rejects.toThrow(
        /non-negative integer/,
      );
    }
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec rejects fail-closed when SDK does not advertise supportsMaxOutputBytes", async () => {
    // The SandboxExecOptions contract guarantees a 1 MB default cap on
    // stdout+stderr. Without server-side enforcement the adapter would have
    // already buffered unbounded output by the time any cap could apply,
    // so it refuses to dispatch.
    const base = createFakeSandbox();
    const sdk = { ...base, commands: { ...base.commands, supportsMaxOutputBytes: false } };
    const instance = createE2bInstance(sdk);
    await expect(instance.exec("ls", [])).rejects.toThrow(/supportsMaxOutputBytes/);
  });

  test("exec forwards the contract default 1 MB cap when caller omits maxOutputBytes", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.exec("ls", []);
    expect(sdk.runCalls[0]?.opts?.maxOutputBytes).toBe(1_000_000);
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
        run: async (): Promise<import("./types.js").E2bRunResult> => ({
          exitCode: 0,
          stdout: "a".repeat(800),
          stderr: "b".repeat(800),
        }),
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

  test("exec defensively re-trims oversized SDK output to the contract default cap", async () => {
    // Even with server-side enforcement, the adapter re-applies the cap as
    // a defensive measure in case the SDK's enforcement is approximate.
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
    const instance = createE2bInstance(sdk);
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
