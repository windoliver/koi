import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { execSandboxed, spawnBash } from "./exec.js";

describe("spawnBash — streaming callbacks", () => {
  test("without callbacks: behavior byte-identical to prior", async () => {
    const r = await spawnBash(
      "echo hello && echo world >&2",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("world");
  });

  test("with onStdout: callback fires as bytes arrive", async () => {
    const chunks: string[] = [];
    const r = await spawnBash(
      "for i in 1 2 3; do echo line$i; sleep 0.02; done",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStdout: (c) => chunks.push(c) },
    );
    expect(r.exitCode).toBe(0);
    const concatenated = chunks.join("");
    expect(concatenated).toContain("line1");
    expect(concatenated).toContain("line3");
  });

  test("onStderr: fires for stderr bytes", async () => {
    const chunks: string[] = [];
    const r = await spawnBash(
      "echo warn-msg >&2",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStderr: (c) => chunks.push(c) },
    );
    expect(r.exitCode).toBe(0);
    expect(chunks.join("")).toContain("warn-msg");
  });

  test("callbacks continue firing after capture cap is exhausted", async () => {
    // Emit 2 MB of filler then a late marker. maxOutputBytes = 1 MB.
    const cmd = `yes x | head -c 2000000; echo LATE_MARKER`;
    const stdoutChunks: string[] = [];
    const r = await spawnBash(cmd, process.cwd(), 20_000, 1_000_000, undefined, undefined, {
      onStdout: (c) => stdoutChunks.push(c),
    });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(1_100_000);
    expect(stdoutChunks.join("")).toContain("LATE_MARKER");
  });

  test("callback throwing does not break the drain loop", async () => {
    const r = await spawnBash(
      "echo one && echo two",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      {
        onStdout: () => {
          throw new Error("consumer bug");
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("one");
    expect(r.stdout).toContain("two");
  });
});

// ---------------------------------------------------------------------------
// execSandboxed — callback threading (mock adapter, no real sandbox binary)
// ---------------------------------------------------------------------------

/** Captured exec options from the mock adapter — box type avoids exactOptionalPropertyTypes issues. */
interface CapturedExecOpts {
  onStdout: ((chunk: string) => void) | undefined;
  onStderr: ((chunk: string) => void) | undefined;
}

/**
 * Build a minimal mock SandboxAdapter that captures exec opts for assertions.
 * The captured onStdout/onStderr callbacks are what we need to verify are threaded.
 */
function makeMockAdapter(captured: CapturedExecOpts): SandboxAdapter {
  const instance: SandboxInstance = {
    async exec(
      _command: string,
      _args: readonly string[],
      execOpts?: import("@koi/core").SandboxExecOptions,
    ): Promise<SandboxAdapterResult> {
      // Use explicit assignment with explicit type annotation to satisfy exactOptionalPropertyTypes.
      captured.onStdout = execOpts?.onStdout ?? undefined;
      captured.onStderr = execOpts?.onStderr ?? undefined;
      return {
        exitCode: 0,
        stdout: "mock-stdout",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        oomKilled: false,
      };
    },
    async readFile(_path: string): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async writeFile(_path: string, _data: Uint8Array): Promise<void> {},
    async destroy(): Promise<void> {},
  };

  return {
    name: "mock-adapter",
    async create(_profile: SandboxProfile): Promise<SandboxInstance> {
      return instance;
    },
  };
}

const testProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describe("execSandboxed — callback threading", () => {
  test("threads onStdout callback into SandboxExecOptions", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);
    const onStdout = (_c: string): void => {};

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStdout },
    );

    expect(captured.onStdout).toBe(onStdout);
    expect(captured.onStderr).toBeUndefined();
  });

  test("threads onStderr callback into SandboxExecOptions", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);
    const onStderr = (_c: string): void => {};

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStderr },
    );

    expect(captured.onStdout).toBeUndefined();
    expect(captured.onStderr).toBe(onStderr);
  });

  test("omits onStdout/onStderr from opts when callbacks is undefined (source-compatible)", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
    );

    expect(captured.onStdout).toBeUndefined();
    expect(captured.onStderr).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// spawnBash — abort signal / process cleanup (regression for #1914)
//
// Proof strategy: the stdout/stderr pipe has a write end held by every
// process in the spawned group. drainStream blocks until ALL write ends
// are closed. If any child survives the abort (orphan), spawnBash hangs
// and the test times out. Returning == all processes dead.
//
// No wall-clock timing assertions — correctness is proved by:
//   1. The function returning at all (pipe close = all processes dead)
//   2. pgrep confirming a specific PID was never created (no-spawn path)
// ---------------------------------------------------------------------------

describe("spawnBash — abort signal kills child processes (no orphan)", () => {
  test("abort resolves spawnBash for a long-running command", async () => {
    // If any process survives and keeps the pipe open, drainStream hangs
    // and this test times out. Returning proves cleanup was complete.
    const controller = new AbortController();

    const promise = spawnBash("sleep 100", process.cwd(), 120_000, 1_000_000, controller.signal);

    await new Promise<void>((r) => setTimeout(r, 200));
    controller.abort();

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  test("abort kills child processes spawned by the bash script", async () => {
    // `true; sleep 100` forces bash to fork a child rather than exec-into sleep.
    // sleep inherits bash's process group; the group SIGTERM must reach it.
    // If sleep escapes, it holds the pipe open and this test times out.
    const controller = new AbortController();

    const promise = spawnBash(
      "true; sleep 100",
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
    );

    await new Promise<void>((r) => setTimeout(r, 300));
    controller.abort();

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  test("already-aborted signal throws AbortError without spawning any process", async () => {
    // throwIfAborted() is called before spawnChild, so no child should be created.
    // Use a unique sleep duration as a fingerprint: if spawnChild ran, pgrep finds it.
    const uniqueSecs = 999_937; // astronomically unlikely to be running elsewhere
    const controller = new AbortController();
    controller.abort();

    let thrownError: unknown;
    try {
      await spawnBash(`sleep ${uniqueSecs}`, process.cwd(), 60_000, 1_000_000, controller.signal);
    } catch (e: unknown) {
      thrownError = e;
    }

    // Must throw AbortError — callers (turn-runner) rely on this contract
    expect(thrownError).toBeDefined();
    expect((thrownError as { name?: string }).name).toBe("AbortError");

    // No child was spawned: pgrep for the fingerprint must return empty
    const pgrep = spawnSync("pgrep", ["-f", String(uniqueSecs)], { encoding: "utf8" });
    expect(pgrep.stdout.trim()).toBe("");
  });

  test("SIGKILL escalation terminates SIGTERM-immune processes", async () => {
    // bash ignores SIGTERM via trap '' TERM; only SIGKILL (after
    // SIGKILL_ESCALATION_MS) can kill it. If escalation is broken,
    // drainStream hangs and this test times out at 8 s.
    const controller = new AbortController();

    const promise = spawnBash(
      "trap '' TERM; while true; do sleep 0.05; done",
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
    );

    await new Promise<void>((r) => setTimeout(r, 200));
    controller.abort();

    // Returns only after SIGKILL escalation (~3 s). Timing out = escalation broken.
    await promise;
  }, 8_000);
});
