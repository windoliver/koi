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

  test("replays a pre-bind SIGUSR1 once the child ref is bound", async () => {
    const guard = armTuiReexecSignalHandlers();
    // Signal arrives before bindChild — handler records the pending flag.
    process.emit("SIGUSR1", "SIGUSR1");

    const fake = makeFakeSubprocess();
    guard.bindChild(fake.proc);

    expect(fake.kills).toEqual(["SIGUSR1"]);

    fake.resolveExit(0);
    await fake.exited;
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
