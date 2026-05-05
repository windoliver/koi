/**
 * mutations.ts — produce()-style draft mutators. These run only on the
 * streaming-text fast path today, so this test exists to keep the supervisor
 * + bg cases at parity with the pure reducer (Decision 9A regression net).
 */

import { describe, expect, test } from "bun:test";
import type { SupervisorHealth } from "@koi/core/daemon";
import { createStore, produce } from "solid-js/store";
import { createInitialState } from "./initial.js";
import { mutate } from "./mutations.js";
import type { BgSessionRow, TuiState } from "./types.js";

const SAMPLE_HEALTH: SupervisorHealth = {
  status: "ok",
  reasons: [],
  workers: [],
  metrics: {
    poolSize: 0,
    maxWorkers: 4,
    quarantinedCount: 0,
    restartingCount: 0,
    pendingSpawnCount: 0,
    eventDropCount: 0,
    shuttingDown: false,
  },
};

function withDraft(action: Parameters<typeof mutate>[1]): TuiState {
  const [state, setState] = createStore<TuiState>(createInitialState());
  setState(produce((draft) => mutate(draft, action)));
  return state;
}

describe("mutate — supervisor slice", () => {
  test("set_supervisor_attached(true) sets attached", () => {
    const s = withDraft({ kind: "set_supervisor_attached", attached: true });
    expect(s.supervisor.attached).toBe(true);
  });

  test("set_supervisor_attached(false) clears health", () => {
    const [state, setState] = createStore<TuiState>(createInitialState());
    setState(produce((d) => mutate(d, { kind: "set_supervisor_attached", attached: true })));
    setState(produce((d) => mutate(d, { kind: "set_supervisor_health", health: SAMPLE_HEALTH })));
    expect(state.supervisor.health).toBeTruthy();
    setState(produce((d) => mutate(d, { kind: "set_supervisor_attached", attached: false })));
    expect(state.supervisor.attached).toBe(false);
    expect(state.supervisor.health).toBeNull();
  });

  test("set_supervisor_status replaces status", () => {
    const s = withDraft({ kind: "set_supervisor_status", status: { kind: "live" } });
    expect(s.supervisor.status).toEqual({ kind: "live" });
  });

  test("set_supervisor_health replaces health", () => {
    const s = withDraft({ kind: "set_supervisor_health", health: SAMPLE_HEALTH });
    expect(s.supervisor.health).toEqual(SAMPLE_HEALTH);
  });

  test("push_supervisor_event prepends + caps at 50", () => {
    const [state, setState] = createStore<TuiState>(createInitialState());
    for (let i = 0; i < 60; i++) {
      setState(
        produce((d) =>
          mutate(d, {
            kind: "push_supervisor_event",
            entry: { id: `e${i}`, ts: i, kind: "started", workerId: "w", agentName: "a" },
          }),
        ),
      );
    }
    expect(state.supervisor.events.length).toBe(50);
    expect(state.supervisor.events[0]?.id).toBe("e59");
    expect(state.supervisor.events[49]?.id).toBe("e10");
  });

  test("clear_supervisor_events empties buffer", () => {
    const [state, setState] = createStore<TuiState>(createInitialState());
    setState(
      produce((d) =>
        mutate(d, {
          kind: "push_supervisor_event",
          entry: { id: "x", ts: 0, kind: "started", workerId: "w", agentName: "a" },
        }),
      ),
    );
    setState(produce((d) => mutate(d, { kind: "clear_supervisor_events" })));
    expect(state.supervisor.events.length).toBe(0);
  });
});

describe("mutate — bg slice", () => {
  const SAMPLE_ROW: BgSessionRow = {
    workerId: "w1",
    agentId: "a1",
    sessionId: null,
    status: "running",
    pid: 1234,
    startedAt: 0,
    endedAt: null,
    exitCode: null,
    lastHeartbeatAt: null,
    heartbeatDeadlineAt: null,
    logPath: "",
    backendKind: "subprocess",
    version: 1,
    signaledAt: null,
    freshness: "ok",
  };

  test("set_bg_rows replaces rows", () => {
    const s = withDraft({ kind: "set_bg_rows", rows: [SAMPLE_ROW] });
    expect(s.bg.rows).toEqual([SAMPLE_ROW]);
  });

  test("set_bg_registry_status replaces status", () => {
    const s = withDraft({
      kind: "set_bg_registry_status",
      status: { kind: "stale", since: 1, reason: "boom" },
    });
    expect(s.bg.registryStatus).toEqual({ kind: "stale", since: 1, reason: "boom" });
  });

  test("set_bg_tailing toggles workerId", () => {
    const [state, setState] = createStore<TuiState>(createInitialState());
    setState(produce((d) => mutate(d, { kind: "set_bg_tailing", workerId: "w1" })));
    expect(state.bg.tailingWorkerId).toBe("w1");
    setState(produce((d) => mutate(d, { kind: "set_bg_tailing", workerId: null })));
    expect(state.bg.tailingWorkerId).toBeNull();
  });

  test("set_bg_kill_confirm toggles confirm payload", () => {
    const [state, setState] = createStore<TuiState>(createInitialState());
    setState(
      produce((d) =>
        mutate(d, {
          kind: "set_bg_kill_confirm",
          confirm: { workerId: "w1", version: 3, pid: 7 },
        }),
      ),
    );
    expect(state.bg.killConfirm).toEqual({ workerId: "w1", version: 3, pid: 7 });
    setState(produce((d) => mutate(d, { kind: "set_bg_kill_confirm", confirm: null })));
    expect(state.bg.killConfirm).toBeNull();
  });
});
