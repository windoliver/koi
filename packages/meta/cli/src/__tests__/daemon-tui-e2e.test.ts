/**
 * Daemon TUI E2E — gated on $RUN_E2E so CI default-skips.
 *
 * Drives the real `@koi/daemon` `Supervisor` + `FileSessionRegistry` through
 * the production `createDaemonBridge` (live mode) into the actual TUI store.
 * No tmux harness — the TUI rendering is exercised separately in the
 * component tests; this suite proves the integration spine end-to-end:
 * manifest declares subprocess supervision → bridge attaches → supervisor
 * spawns a real subprocess → registry records it → bridge dispatches into
 * the store → operator-visible side effects (badge, /bg row, kill flow).
 *
 * To run: `RUN_E2E=1 bun test packages/meta/cli/src/__tests__/daemon-tui-e2e.test.ts`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, WorkerId } from "@koi/core";
import { agentId as makeAgentId, workerId as makeWorkerId } from "@koi/core";
import {
  attachRegistry,
  createFileSessionRegistry,
  createSubprocessBackend,
  createSupervisor,
} from "@koi/daemon";
import type { TuiAction, TuiState } from "@koi/tui";
import { createInitialState, reduce } from "@koi/tui/state";
import { createDaemonBridge } from "../daemon-bridge.js";

const E2E = process.env["RUN_E2E"] === "1" || process.env["RUN_E2E"] === "true";

interface Harness {
  readonly state: () => TuiState;
  readonly dispatch: (a: TuiAction) => void;
}

function makeHarness(): Harness {
  // let: snapshot updated on every dispatch — single-writer harness.
  let s = createInitialState();
  return {
    state: () => s,
    dispatch: (a: TuiAction) => {
      s = reduce(s, a);
    },
  };
}

async function writeWorkerScript(dir: string): Promise<string> {
  const path = join(dir, "worker.sh");
  await writeFile(path, "#!/usr/bin/env bash\necho started\nsleep 30\n");
  await chmod(path, 0o755);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe.skipIf(!E2E)("daemon TUI E2E (live supervisor)", () => {
  let stateDir: string;
  let workerScript: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "koi-tui-e2e-"));
    workerScript = await writeWorkerScript(stateDir);
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test("subprocess spawn → bridge dispatches set_bg_rows + supervisor_health", async () => {
    const registry = createFileSessionRegistry({ dir: stateDir });
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 5_000,
      backends: { subprocess: createSubprocessBackend() },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1000,
        backoffCeilingMs: 30_000,
      },
    });
    if (!supervisorResult.ok) throw new Error(supervisorResult.error.message);
    const supervisor = supervisorResult.value;
    const attachHandle = attachRegistry({ supervisor, registry });
    const harness = makeHarness();
    const bridge = createDaemonBridge({
      mode: { kind: "live", registry, supervisor },
      dispatch: harness.dispatch,
      pushToast: () => {},
      intervals: { registryPollMs: 100, healthPollMs: 100 },
    });

    try {
      const wid = makeWorkerId("e2e-worker-1") as WorkerId;
      const aid = makeAgentId("e2e.agent") as AgentId;
      bridge.markLocallySpawned(String(wid));
      const reg = await registry.register({
        workerId: wid,
        agentId: aid,
        pid: 0,
        status: "starting",
        startedAt: Date.now(),
        logPath: "",
        command: [workerScript],
        backendKind: "subprocess",
      });
      expect(reg.ok).toBe(true);
      const startResult = await supervisor.start({
        workerId: wid,
        agentId: aid,
        command: [workerScript],
      });
      expect(startResult.ok).toBe(true);

      const observed = await waitFor(
        () => harness.state().bg.rows.some((r) => r.workerId === String(wid)),
        5_000,
      );
      expect(observed).toBe(true);
      expect(harness.state().supervisor.health).not.toBeNull();
    } finally {
      await supervisor.shutdown("e2e teardown");
      await bridge.close();
      await attachHandle.close();
    }
  }, 15_000);

  test("requestKill terminates a running worker → registry transitions to exited", async () => {
    const registry = createFileSessionRegistry({ dir: stateDir });
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 5_000,
      backends: { subprocess: createSubprocessBackend() },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 60_000,
        backoffBaseMs: 1000,
        backoffCeilingMs: 30_000,
      },
    });
    if (!supervisorResult.ok) throw new Error(supervisorResult.error.message);
    const supervisor = supervisorResult.value;
    const attachHandle = attachRegistry({ supervisor, registry });
    const harness = makeHarness();
    const bridge = createDaemonBridge({
      mode: { kind: "live", registry, supervisor },
      dispatch: harness.dispatch,
      pushToast: () => {},
      intervals: { registryPollMs: 100, healthPollMs: 100 },
    });

    try {
      const wid = makeWorkerId("e2e-worker-2") as WorkerId;
      const aid = makeAgentId("e2e.agent2") as AgentId;
      bridge.markLocallySpawned(String(wid));
      await registry.register({
        workerId: wid,
        agentId: aid,
        pid: 0,
        status: "starting",
        startedAt: Date.now(),
        logPath: "",
        command: [workerScript],
        backendKind: "subprocess",
      });
      const startResult = await supervisor.start({
        workerId: wid,
        agentId: aid,
        command: [workerScript],
      });
      expect(startResult.ok).toBe(true);

      const reachedRunning = await waitFor(() => {
        const row = harness
          .state()
          .bg.rows.find((r) => r.workerId === String(wid) && r.status === "running");
        return row !== undefined;
      }, 5_000);
      expect(reachedRunning).toBe(true);

      const row = harness
        .state()
        .bg.rows.find((r) => r.workerId === String(wid) && r.status === "running");
      if (row === undefined) throw new Error("running row vanished");

      const outcome = await bridge.requestKill({
        workerId: row.workerId,
        expectedVersion: row.version,
        expectedPid: row.pid,
      });
      expect(outcome.kind).toBe("stopped");

      const reachedExited = await waitFor(() => {
        const r = harness.state().bg.rows.find((x) => x.workerId === String(wid));
        return r?.status === "exited";
      }, 5_000);
      expect(reachedExited).toBe(true);
    } finally {
      await supervisor.shutdown("e2e teardown");
      await bridge.close();
      await attachHandle.close();
    }
  }, 20_000);
});

// Always-on sanity guard so the file's compile + scaffold stay healthy
// regardless of whether the gated suite runs.
test("daemon-tui-e2e harness: $RUN_E2E gating wired", () => {
  expect(typeof E2E).toBe("boolean");
});
