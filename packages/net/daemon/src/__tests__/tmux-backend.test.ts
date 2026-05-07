import { describe, expect, it } from "bun:test";
import { agentId, workerId } from "@koi/core";
import { createTmuxBackend } from "../tmux-backend.js";

interface TmuxReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface PaneState {
  readonly paneId: string;
  readonly sessionName: string;
  readonly windowTarget: string;
  readonly pid: number;
  alive: boolean;
  exitCode: number;
}

interface TmuxHarnessOptions {
  readonly versionAvailable?: boolean;
  readonly failSelectPane?: boolean;
  readonly failSendKeys?: boolean;
}

function createTmuxHarness(opts?: TmuxHarnessOptions) {
  const calls: string[][] = [];
  const panes = new Map<string, PaneState>();
  let sessionExists = false;
  let nextPane = 1;
  let nextPid = 4100;

  const findTarget = (args: readonly string[]): string | undefined => {
    const idx = args.indexOf("-t");
    return idx === -1 ? undefined : args[idx + 1];
  };

  const runTmux = async (args: readonly string[]): Promise<TmuxReply> => {
    calls.push([...args]);

    if (args[0] === "-V") {
      return opts?.versionAvailable === false
        ? { code: 127, stdout: "", stderr: "tmux: command not found" }
        : { code: 0, stdout: "tmux 3.4", stderr: "" };
    }

    if (args[0] === "has-session") {
      return sessionExists
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "can't find session" };
    }

    if (args[0] === "new-session" || args[0] === "split-window") {
      const rawTarget = findTarget(args);
      const sessionName =
        args[0] === "split-window"
          ? String(rawTarget?.split(":")[0] ?? "missing")
          : String(args[args.indexOf("-s") + 1] ?? "missing");
      const paneId = `%${nextPane++}`;
      const pid = nextPid++;
      const windowTarget = `${sessionName}:0`;
      panes.set(paneId, {
        paneId,
        sessionName,
        windowTarget,
        pid,
        alive: true,
        exitCode: 0,
      });
      sessionExists = true;
      return {
        code: 0,
        stdout: `${sessionName}\t${windowTarget}\t${paneId}\t${pid}\n`,
        stderr: "",
      };
    }

    if (args[0] === "select-pane") {
      if (opts?.failSelectPane === true) {
        return { code: 1, stdout: "", stderr: "failed to title pane" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "send-keys") {
      if (opts?.failSendKeys === true && !args.includes("C-c") && !args.includes("exit")) {
        return { code: 1, stdout: "", stderr: "failed to send keys" };
      }
      const paneId = findTarget(args);
      const pane = paneId === undefined ? undefined : panes.get(paneId);
      if (pane === undefined) return { code: 1, stdout: "", stderr: "can't find pane" };
      if (args.includes("C-c") || args.includes("exit")) {
        pane.alive = false;
        pane.exitCode = 0;
      }
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "kill-pane") {
      const paneId = findTarget(args);
      const pane = paneId === undefined ? undefined : panes.get(paneId);
      if (pane === undefined || !pane.alive) {
        return { code: 1, stdout: "", stderr: "can't find pane" };
      }
      pane.alive = false;
      pane.exitCode = 137;
      if (paneId === undefined) return { code: 1, stdout: "", stderr: "missing pane" };
      panes.delete(paneId);
      if (panes.size === 0) sessionExists = false;
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "kill-session") {
      const sessionName = findTarget(args);
      if (sessionName === undefined) return { code: 1, stdout: "", stderr: "missing session" };
      for (const [paneId, pane] of panes.entries()) {
        if (pane.sessionName === sessionName) panes.delete(paneId);
      }
      sessionExists = false;
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "display-message") {
      const paneId = findTarget(args);
      const pane = paneId === undefined ? undefined : panes.get(paneId);
      if (pane === undefined) return { code: 1, stdout: "", stderr: "can't find pane" };
      return {
        code: 0,
        stdout: `${pane.alive ? 0 : 1}\t${pane.exitCode}\t${pane.pid}\n`,
        stderr: "",
      };
    }

    throw new Error(`Unexpected tmux call: ${args.join(" ")}`);
  };

  return {
    runTmux,
    calls,
    paneIds: (): string[] => [...panes.keys()],
    sessionNames: (): string[] => [...new Set([...panes.values()].map((pane) => pane.sessionName))],
    removePane: (paneId: string): void => {
      panes.delete(paneId);
      if (panes.size === 0) sessionExists = false;
    },
  };
}

describe("tmux backend", () => {
  it("reports unavailable when tmux is missing", async () => {
    const harness = createTmuxHarness({ versionAvailable: false });
    const backend = createTmuxBackend({
      cwd: "/tmp/otter-worktree",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    expect(await backend.isAvailable()).toBe(false);
  });

  it("spawns a pane and returns backendKind=tmux", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/spry-wombat",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-1"),
      agentId: agentId("agent-tmux-1"),
      command: ["bun", "--version"],
      cwd: "/tmp/spry-wombat",
    });

    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.backendKind).toBe("tmux");
    expect(spawned.value.tmuxSessionName).toMatch(/^tmp-spry-wombat-[a-f0-9]{8}-daemon-workers$/);
    expect(spawned.value.tmuxWindowTarget).toBe(`${spawned.value.tmuxSessionName}:0`);
    expect(spawned.value.tmuxPaneId).toBe("%1");
    expect(await backend.isAlive(workerId("tmux-1"))).toBe(true);
    expect(harness.paneIds()).toEqual(["%1"]);
    expect(
      harness.calls.some((call) =>
        call.some((part) => /^tmp-spry-wombat-[a-f0-9]{8}-daemon-workers$/.test(part)),
      ),
    ).toBe(true);
  });

  it("uses a worktree-scoped session slug instead of basename alone", async () => {
    const firstHarness = createTmuxHarness();
    const secondHarness = createTmuxHarness();
    const thirdHarness = createTmuxHarness();
    const firstBackend = createTmuxBackend({
      cwd: "/Users/sophiawj/.codex/worktrees/0cb9/koi",
      runTmux: firstHarness.runTmux,
      pollIntervalMs: 1,
    });
    const secondBackend = createTmuxBackend({
      cwd: "/Users/sophiawj/private/koi",
      runTmux: secondHarness.runTmux,
      pollIntervalMs: 1,
    });
    const thirdBackend = createTmuxBackend({
      cwd: "/tmp/scratch/0cb9/koi",
      runTmux: thirdHarness.runTmux,
      pollIntervalMs: 1,
    });

    const first = await firstBackend.spawn({
      workerId: workerId("tmux-worktree-a"),
      agentId: agentId("agent-tmux-worktree-a"),
      command: ["bun", "--version"],
    });
    const second = await secondBackend.spawn({
      workerId: workerId("tmux-worktree-b"),
      agentId: agentId("agent-tmux-worktree-b"),
      command: ["bun", "--revision"],
    });
    const third = await thirdBackend.spawn({
      workerId: workerId("tmux-worktree-c"),
      agentId: agentId("agent-tmux-worktree-c"),
      command: ["bun", "--help"],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(firstHarness.sessionNames()).toHaveLength(1);
    expect(secondHarness.sessionNames()).toHaveLength(1);
    expect(thirdHarness.sessionNames()).toHaveLength(1);
    expect(firstHarness.sessionNames()[0]).not.toBe(secondHarness.sessionNames()[0]);
    expect(firstHarness.sessionNames()[0]).not.toBe(thirdHarness.sessionNames()[0]);
    expect(firstHarness.sessionNames()[0]).toContain("0cb9-koi");
    expect(secondHarness.sessionNames()[0]).toContain("private-koi");
    expect(thirdHarness.sessionNames()[0]).toContain("0cb9-koi");
  });

  it("cleans up the created pane when spawn fails after pane creation", async () => {
    const harness = createTmuxHarness({ failSendKeys: true });
    const backend = createTmuxBackend({
      cwd: "/tmp/careful-koala",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-spawn-fail"),
      agentId: agentId("agent-tmux-spawn-fail"),
      command: ["bun", "--version"],
    });

    expect(spawned.ok).toBe(false);
    expect(harness.paneIds()).toEqual([]);
    expect(harness.calls.some((call) => call[0] === "kill-pane")).toBe(true);
  });

  it("terminates a long-running pane", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/steady-fox",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-2"),
      agentId: agentId("agent-tmux-2"),
      command: ["bun", "-e", "setTimeout(() => {}, 10000)"],
    });
    expect(spawned.ok).toBe(true);

    await backend.terminate(workerId("tmux-2"), "test");

    expect(await backend.isAlive(workerId("tmux-2"))).toBe(false);
  });

  it("kill is idempotent when the pane is already gone", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/calm-badger",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-3"),
      agentId: agentId("agent-tmux-3"),
      command: ["bun", "-e", "setTimeout(() => {}, 10000)"],
    });
    expect(spawned.ok).toBe(true);

    harness.removePane("%1");
    const killed = await backend.kill(workerId("tmux-3"));

    expect(killed.ok).toBe(true);
    expect(await backend.isAlive(workerId("tmux-3"))).toBe(false);
  });

  it("multiple workers get distinct pane ids", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/busy-raven",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
    });

    const first = await backend.spawn({
      workerId: workerId("tmux-a"),
      agentId: agentId("agent-tmux-a"),
      command: ["bun", "--version"],
    });
    const second = await backend.spawn({
      workerId: workerId("tmux-b"),
      agentId: agentId("agent-tmux-b"),
      command: ["bun", "--revision"],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(harness.paneIds()).toEqual(["%1", "%2"]);
    expect(harness.sessionNames()).toHaveLength(1);
    expect(harness.sessionNames()[0]).toMatch(/^tmp-busy-raven-[a-f0-9]{8}-daemon-workers$/);
    expect(
      harness.calls.some(
        (call) =>
          call[0] === "split-window" &&
          call.some((part) => /^tmp-busy-raven-[a-f0-9]{8}-daemon-workers:0$/.test(part)),
      ),
    ).toBe(true);
  });

  it("watch returns when AbortSignal fires mid-iteration", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/bright-heron",
      runTmux: harness.runTmux,
      pollIntervalMs: 5,
      pruneGraceMs: 5,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-watch"),
      agentId: agentId("agent-tmux-watch"),
      command: ["bun", "-e", "setTimeout(() => {}, 10000)"],
    });
    expect(spawned.ok).toBe(true);

    const controller = new AbortController();
    const events: string[] = [];
    const done = (async (): Promise<void> => {
      for await (const ev of backend.watch(workerId("tmux-watch"), controller.signal)) {
        events.push(ev.kind);
        if (ev.kind === "started") {
          queueMicrotask(() => controller.abort());
        }
      }
    })();

    await Promise.race([
      done,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);

    expect(events).toContain("started");
  });

  it("prunes terminal worker state even when no watcher drains it", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/prune-bison",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
      pruneGraceMs: 5,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-prune-nowatch"),
      agentId: agentId("agent-tmux-prune-nowatch"),
      command: ["bun", "-e", "setTimeout(() => {}, 10000)"],
    });
    expect(spawned.ok).toBe(true);

    await backend.terminate(workerId("tmux-prune-nowatch"), "test");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replayed: string[] = [];
    for await (const ev of backend.watch(workerId("tmux-prune-nowatch"))) {
      replayed.push(ev.kind);
    }

    expect(replayed).toEqual([]);
  });

  it("prunes terminal worker state after watch aborts before replay completes", async () => {
    const harness = createTmuxHarness();
    const backend = createTmuxBackend({
      cwd: "/tmp/prune-hawk",
      runTmux: harness.runTmux,
      pollIntervalMs: 1,
      pruneGraceMs: 5,
    });

    const spawned = await backend.spawn({
      workerId: workerId("tmux-prune-abort"),
      agentId: agentId("agent-tmux-prune-abort"),
      command: ["bun", "-e", "setTimeout(() => {}, 10000)"],
    });
    expect(spawned.ok).toBe(true);

    const controller = new AbortController();
    const seen: string[] = [];
    const watching = (async (): Promise<void> => {
      for await (const ev of backend.watch(workerId("tmux-prune-abort"), controller.signal)) {
        seen.push(ev.kind);
        controller.abort();
      }
    })();
    await watching;
    expect(seen).toEqual(["started"]);

    await backend.terminate(workerId("tmux-prune-abort"), "test");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replayed: string[] = [];
    for await (const ev of backend.watch(workerId("tmux-prune-abort"))) {
      replayed.push(ev.kind);
    }

    expect(replayed).toEqual([]);
  });
});
