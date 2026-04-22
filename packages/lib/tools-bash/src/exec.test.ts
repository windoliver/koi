import { describe, expect, test } from "bun:test";
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
    // Readiness handshake: echo READY before the long sleep so we know
    // the process is actually running before we abort. If any process
    // survives and keeps the pipe open, drainStream hangs and this test
    // times out. Returning proves cleanup was complete.
    const controller = new AbortController();
    const stdoutChunks: string[] = [];

    const promise = spawnBash(
      "echo READY; sleep 100",
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
      undefined,
      { onStdout: (c) => stdoutChunks.push(c) },
    );

    // Wait until the process signals it is running before aborting.
    await new Promise<void>((r) => {
      const check = (): void => {
        if (stdoutChunks.join("").includes("READY")) {
          r();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    controller.abort();

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  test("abort kills child processes spawned by the bash script", async () => {
    // Forces bash to fork a background sleep child and emit its PID.
    // We confirm the child is alive (process.kill(pid, 0) succeeds) BEFORE
    // aborting, so the test cannot pass vacuously by killing only the shell.
    // If the child survives abort it holds the pipe open and the test times out.
    const controller = new AbortController();
    const stderrChunks: string[] = [];

    const promise = spawnBash(
      // Background sleep; print its PID so the test can verify it's alive.
      'sleep 100 & echo "CHILD:$!" >&2; wait',
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
      undefined,
      { onStderr: (c) => stderrChunks.push(c) },
    );

    // Parse the child PID from the readiness signal.
    const childPid = await new Promise<number>((resolve) => {
      const check = (): void => {
        const match = /CHILD:(\d+)/.exec(stderrChunks.join(""));
        const pid = match?.[1];
        if (pid !== undefined) {
          resolve(Number(pid));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    // Hard precondition: child MUST be alive before we abort.
    // If kill(pid,0) throws, the child was not yet started or died spontaneously —
    // both indicate test-setup failure rather than the cleanup scenario under test.
    expect(() => process.kill(childPid, 0)).not.toThrow();

    controller.abort();

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  test("abort kills fd-redirecting descendants that do not hold the inherited pipe", async () => {
    // A child that redirects all its fds away from inherited pipes does NOT keep
    // the stdout/stderr pipe open, so pipe closure alone cannot detect its death.
    // Without process-group kill, spawnBash could return (pipe closed by bash's
    // death via `wait`) while the fd-redirecting sleep is still alive. This test
    // verifies the group SIGTERM reaches that child.
    const controller = new AbortController();
    const stderrChunks: string[] = [];

    const promise = spawnBash(
      // sleep redirects all fds to /dev/null (detached from inherited pipe).
      // bash stays alive via `wait`, keeping the pipe open until abort kills it.
      'sleep 100 >/dev/null 2>&1 & echo "DETACHED:$!" >&2; wait',
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
      undefined,
      { onStderr: (c) => stderrChunks.push(c) },
    );

    const childPid = await new Promise<number>((resolve) => {
      const check = (): void => {
        const match = /DETACHED:(\d+)/.exec(stderrChunks.join(""));
        const pid = match?.[1];
        if (pid !== undefined) {
          resolve(Number(pid));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    // Hard precondition: child must be alive and pipe-detached before abort.
    expect(() => process.kill(childPid, 0)).not.toThrow();

    controller.abort();
    await promise; // pipe closes when bash (the waiter) dies

    // Poll until the fd-redirecting child is gone. It received SIGTERM via process-
    // group kill and has no signal handler, so it dies quickly. Surviving past 2 s
    // means process-group kill is broken.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
      } catch {
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 15_000);

  test("already-aborted signal throws AbortError without spawning any process", async () => {
    // throwIfAborted() fires synchronously before Bun.spawn(), so on a pre-aborted
    // signal no child process is ever created. We prove this with a temp-file
    // side-channel: if bash ran, it would create the file; its absence confirms
    // the spawn path was never entered.
    const spawnMarker = `/tmp/spawnbash-no-spawn-${Date.now()}`;
    const controller = new AbortController();
    controller.abort();

    let thrownError: unknown;
    try {
      await spawnBash(
        `touch ${spawnMarker}; sleep 999`,
        process.cwd(),
        60_000,
        1_000_000,
        controller.signal,
      );
    } catch (e: unknown) {
      thrownError = e;
    }

    // Must throw AbortError — callers (turn-runner) rely on this contract
    expect(thrownError).toBeDefined();
    expect((thrownError as { name?: string }).name).toBe("AbortError");

    // Spawn path was never entered: if Bun.spawn() had run, bash would have
    // created this file before sleeping.
    const spawnOccurred = await Bun.file(spawnMarker).exists();
    expect(spawnOccurred).toBe(false);
  });

  test("SIGKILL escalation terminates SIGTERM-immune processes", async () => {
    // bash ignores SIGTERM via trap '' TERM; only SIGKILL (after
    // SIGKILL_ESCALATION_MS) can kill it. If escalation is broken,
    // drainStream hangs and this test times out at 8 s.
    // Readiness handshake: echo READY to stderr after the trap is installed
    // so we abort only once the immune loop is guaranteed running.
    const controller = new AbortController();
    const stderrChunks: string[] = [];

    const promise = spawnBash(
      "trap '' TERM; echo READY >&2; while true; do sleep 0.05; done",
      process.cwd(),
      120_000,
      1_000_000,
      controller.signal,
      undefined,
      { onStderr: (c) => stderrChunks.push(c) },
    );

    await new Promise<void>((r) => {
      const check = (): void => {
        if (stderrChunks.join("").includes("READY")) {
          r();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    controller.abort();

    // Returns only after SIGKILL escalation (~3 s). Timing out = escalation broken.
    await promise;
  }, 8_000);
});
