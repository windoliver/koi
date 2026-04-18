import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { armTuiReexecSignalHandlers } from "./tui-reexec-signals.js";

interface FakeProc {
  readonly kills: string[];
  readonly exited: Promise<number>;
  readonly resolveExit: (code: number) => void;
  readonly proc: Subprocess;
}

function makeFakeSubprocess(): FakeProc {
  const kills: string[] = [];
  // let: justified — populated synchronously below by Promise constructor.
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const fake = {
    kill: (signal?: string) => {
      kills.push(signal ?? "SIGTERM");
      return true;
    },
    exited,
  };
  return {
    kills,
    exited,
    resolveExit,
    proc: fake as unknown as Subprocess,
  };
}

// Defensive cleanup — every test here emits on the real process, and a
// leaked listener contaminates subsequent tests in the same file.
afterEach(() => {
  process.removeAllListeners("SIGUSR1");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGHUP");
  process.removeAllListeners("SIGINT");
});

describe("armTuiReexecSignalHandlers — SIGUSR1 forwarding (#1906)", () => {
  test("forwards SIGUSR1 to the child without starting the SIGTERM escalation", async () => {
    const fake = makeFakeSubprocess();
    const guard = armTuiReexecSignalHandlers();
    guard.bindChild(fake.proc);

    process.emit("SIGUSR1", "SIGUSR1");

    expect(fake.kills).toEqual(["SIGUSR1"]);
    // SIGUSR1 must NOT flip the termination latch — that latch gates the
    // SIGTERM-style SIGKILL escalation and is only appropriate for
    // non-cooperative parent-initiated termination.
    expect(guard.terminated).toBe(false);

    fake.resolveExit(0);
    await fake.exited;
  });

  test("replays a pre-bind SIGUSR1 once the child ref is bound (after readiness delay)", async () => {
    const guard = armTuiReexecSignalHandlers();
    // Signal arrives before bindChild — handler records the pending flag.
    process.emit("SIGUSR1", "SIGUSR1");

    const fake = makeFakeSubprocess();
    guard.bindChild(fake.proc);

    // Replay is now delayed (CHILD_READY_FOR_SIGUSR1_MS = 500) so the
    // child has time to arm its own handler before the signal lands.
    // Verify nothing fired immediately, then wait past the delay.
    expect(fake.kills).toEqual([]);
    await new Promise((r) => setTimeout(r, 550));
    expect(fake.kills).toEqual(["SIGUSR1"]);

    fake.resolveExit(0);
    await fake.exited;
  });

  test("pre-bind SIGUSR1 flips the termination latch so bin.ts aborts spawn (#1906 R7)", () => {
    const guard = armTuiReexecSignalHandlers();
    // Baseline — guard starts un-terminated.
    expect(guard.terminated).toBe(false);
    expect(guard.shouldKillNewbornChild).toBe(false);

    // Pre-bind SIGUSR1: user wants to escape before the child exists.
    process.emit("SIGUSR1", "SIGUSR1");

    // Now bin.ts will observe `terminated === true` and exit with the
    // SIGUSR1 exit code instead of spawning the browser-build child.
    expect(guard.terminated).toBe(true);
    // 158 (macOS) / 138 (Linux) — platform-canonical 128+SIGUSR1.
    expect([138, 158]).toContain(guard.terminatedExitCode);
    // SIGUSR1 pre-bind is the only case where bin.ts should SIGKILL a
    // newborn child instead of graceful-forwarding (#1906 R9).
    expect(guard.shouldKillNewbornChild).toBe(true);
  });

  test("pre-bind SIGTERM does NOT trigger the newborn-SIGKILL path (#1906 R9)", () => {
    const guard = armTuiReexecSignalHandlers();
    process.emit("SIGTERM", "SIGTERM");

    // terminated flips (graceful forwarding path) but shouldKillNewbornChild
    // stays false so bin.ts takes the regular bindChild+forward path.
    expect(guard.terminated).toBe(true);
    expect(guard.terminatedExitCode).toBe(143);
    expect(guard.shouldKillNewbornChild).toBe(false);
  });

  test("pre-bind SIGHUP does NOT trigger the newborn-SIGKILL path (#1906 R9)", () => {
    const guard = armTuiReexecSignalHandlers();
    process.emit("SIGHUP", "SIGHUP");

    expect(guard.terminated).toBe(true);
    expect(guard.terminatedExitCode).toBe(129);
    expect(guard.shouldKillNewbornChild).toBe(false);
  });

  test("removes the SIGUSR1 listener after the child exits", async () => {
    const fake = makeFakeSubprocess();
    const guard = armTuiReexecSignalHandlers();
    guard.bindChild(fake.proc);

    expect(process.listenerCount("SIGUSR1")).toBe(1);

    fake.resolveExit(0);
    await fake.exited;
    // Cleanup runs inside the `proc.exited.then(...)` microtask — await
    // one extra turn so the listener removal lands before assertion.
    await Promise.resolve();

    expect(process.listenerCount("SIGUSR1")).toBe(0);
  });
});
