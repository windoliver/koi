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
  process.removeAllListeners("SIGUSR2");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGHUP");
  process.removeAllListeners("SIGINT");
});

describe("armTuiReexecSignalHandlers — SIGUSR1 forwarding (#1906)", () => {
  test("forwards post-bind SIGUSR1 immediately once child is ready (SIGUSR2 ack received)", async () => {
    const fake = makeFakeSubprocess();
    const guard = armTuiReexecSignalHandlers();
    guard.bindChild(fake.proc);

    // Simulate the child's ready ack (bin.ts sends SIGUSR2 to parent
    // after installing its inline SIGUSR1 handler).
    process.emit("SIGUSR2", "SIGUSR2");

    // Now SIGUSR1 is forwarded immediately with no handshake delay.
    process.emit("SIGUSR1", "SIGUSR1");

    expect(fake.kills).toEqual(["SIGUSR1"]);
    expect(guard.terminated).toBe(false);

    fake.resolveExit(0);
    await fake.exited;
  });

  test("queues post-bind SIGUSR1 until child sends SIGUSR2 ack (#1906 residual)", async () => {
    const fake = makeFakeSubprocess();
    const guard = armTuiReexecSignalHandlers();
    guard.bindChild(fake.proc);

    // SIGUSR1 arrives BEFORE child readiness — must be queued, not
    // forwarded (forwarding now would risk SIGTRAP-ing the child mid-
    // runtime-init).
    process.emit("SIGUSR1", "SIGUSR1");
    expect(fake.kills).toEqual([]);

    // Child arms handler and sends SIGUSR2 ack. Queue drains
    // synchronously.
    process.emit("SIGUSR2", "SIGUSR2");
    expect(fake.kills).toEqual(["SIGUSR1"]);

    fake.resolveExit(0);
    await fake.exited;
  });

  test("pre-bind SIGUSR1 is queued and drained by child readiness ack", async () => {
    const guard = armTuiReexecSignalHandlers();
    // Pre-bind SIGUSR1 sets pendingSigusr1 (and flips terminated). bin.ts
    // would normally exit at this point; this test simulates the path
    // where bin.ts does NOT early-exit (direct unit test of bindChild).
    process.emit("SIGUSR1", "SIGUSR1");
    expect(guard.terminated).toBe(true);

    const fake = makeFakeSubprocess();
    guard.bindChild(fake.proc);

    // Still queued — waiting for child ack.
    expect(fake.kills).toEqual([]);

    // Child ack drains the queue.
    process.emit("SIGUSR2", "SIGUSR2");
    expect(fake.kills).toEqual(["SIGUSR1"]);

    fake.resolveExit(0);
    await fake.exited;
  });

  test("readiness backstop drains queue if SIGUSR2 ack never arrives", async () => {
    const guard = armTuiReexecSignalHandlers();
    process.emit("SIGUSR1", "SIGUSR1");

    const fake = makeFakeSubprocess();
    guard.bindChild(fake.proc);

    // Ack never arrives. After CHILD_READY_FOR_SIGUSR1_MS (500ms), the
    // backstop promotes to ready and drains the queue — degrades to
    // pre-handshake behavior rather than silently losing the signal.
    expect(fake.kills).toEqual([]);
    await new Promise((r) => setTimeout(r, 600));
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

  test("removes the SIGUSR1 and SIGUSR2 listeners after the child exits", async () => {
    const fake = makeFakeSubprocess();
    const guard = armTuiReexecSignalHandlers();
    guard.bindChild(fake.proc);

    expect(process.listenerCount("SIGUSR1")).toBe(1);
    expect(process.listenerCount("SIGUSR2")).toBe(1);

    fake.resolveExit(0);
    await fake.exited;
    // Cleanup runs inside the `proc.exited.then(...)` microtask — await
    // one extra turn so the listener removal lands before assertion.
    await Promise.resolve();

    expect(process.listenerCount("SIGUSR1")).toBe(0);
    expect(process.listenerCount("SIGUSR2")).toBe(0);
  });
});
