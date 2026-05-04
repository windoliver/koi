import { describe, expect, test } from "bun:test";
import type { SupervisorHealth, WorkerHealth, WorkerId } from "@koi/core/daemon";
import type { AgentId } from "@koi/core/ecs";
import { computeFreshness } from "./freshness.js";
import type { BgSessionRow } from "./types.js";

const NOW = 1_700_000_000_000;
const wid = "w1" as WorkerId;
const aid = "a1" as AgentId;

const row = (over: Partial<BgSessionRow> = {}): BgSessionRow => ({
  workerId: "w1",
  agentId: "a1",
  sessionId: null,
  status: "running",
  pid: 1234,
  startedAt: NOW - 60_000,
  endedAt: null,
  exitCode: null,
  lastHeartbeatAt: null,
  heartbeatDeadlineAt: null,
  logPath: "/tmp/log",
  backendKind: "subprocess",
  version: 1,
  signaledAt: null,
  freshness: "ok",
  ...over,
});

const health = (workers: readonly WorkerHealth[]): SupervisorHealth => ({
  status: "ok",
  reasons: [],
  workers,
  metrics: {
    poolSize: workers.length,
    maxWorkers: 4,
    quarantinedCount: 0,
    restartingCount: 0,
    pendingSpawnCount: 0,
    eventDropCount: 0,
    shuttingDown: false,
  },
});

const w = (over: Partial<WorkerHealth> = {}): WorkerHealth => ({
  workerId: wid,
  agentId: aid,
  state: "running",
  lastHeartbeatAt: undefined,
  heartbeatDeadlineAt: undefined,
  ...over,
});

describe("computeFreshness", () => {
  test("running + no health entry → foreign", () => {
    expect(
      computeFreshness({ row: row(), health: health([]), locallySpawnedIds: new Set(), now: NOW }),
    ).toBe("foreign");
  });

  test("running + null health (registry-only mode) → foreign", () => {
    expect(
      computeFreshness({ row: row(), health: null, locallySpawnedIds: new Set(), now: NOW }),
    ).toBe("foreign");
  });

  test("running + health.state=restarting overrides terminal registry status", () => {
    expect(
      computeFreshness({
        row: row({ status: "crashed" }),
        health: health([w({ state: "restarting" })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("restarting");
  });

  test("health.state=quarantined overrides exited registry status", () => {
    expect(
      computeFreshness({
        row: row({ status: "exited" }),
        health: health([w({ state: "quarantined" })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("quarantined");
  });

  test("health.state=stopping overrides", () => {
    expect(
      computeFreshness({
        row: row(),
        health: health([w({ state: "stopping" })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("stopping");
  });

  test("running + heartbeat undefined (opt-out) → unmonitored", () => {
    expect(
      computeFreshness({
        row: row(),
        health: health([w()]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("unmonitored");
  });

  test("running + heartbeat fresh → ok", () => {
    expect(
      computeFreshness({
        row: row(),
        health: health([w({ lastHeartbeatAt: NOW - 1000, heartbeatDeadlineAt: NOW + 5000 })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("ok");
  });

  test("running + heartbeat past deadline within interval → stale", () => {
    expect(
      computeFreshness({
        row: row(),
        health: health([w({ lastHeartbeatAt: NOW - 6000, heartbeatDeadlineAt: NOW - 1000 })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("stale");
  });

  test("running + heartbeat past 2x interval → timeout", () => {
    expect(
      computeFreshness({
        row: row(),
        health: health([w({ lastHeartbeatAt: NOW - 12_000, heartbeatDeadlineAt: NOW - 7000 })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("timeout");
  });

  test("running + heartbeatDeadlineAt set, lastHeartbeatAt undefined, within grace → pending", () => {
    expect(
      computeFreshness({
        row: row({ startedAt: NOW - 10_000 }),
        health: health([w({ heartbeatDeadlineAt: NOW + 5000 })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("pending");
  });

  test("running + heartbeatDeadlineAt set, lastHeartbeatAt undefined, past grace → timeout", () => {
    expect(
      computeFreshness({
        row: row({ startedAt: NOW - 60_000 }),
        health: health([w({ heartbeatDeadlineAt: NOW + 5000 })]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("timeout");
  });

  test("starting + workerId in locallySpawnedIds + within grace → pending", () => {
    expect(
      computeFreshness({
        row: row({ status: "starting", startedAt: NOW - 10_000, pid: 0 }),
        health: health([]),
        locallySpawnedIds: new Set(["w1"]),
        now: NOW,
      }),
    ).toBe("pending");
  });

  test("starting + workerId NOT in locallySpawnedIds → foreign (registry-only mode)", () => {
    expect(
      computeFreshness({
        row: row({ status: "starting", startedAt: NOW - 10_000, pid: 0 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("foreign");
  });

  test("starting locally-spawned past 30s grace → timeout", () => {
    expect(
      computeFreshness({
        row: row({ status: "starting", startedAt: NOW - 60_000, pid: 0 }),
        health: health([]),
        locallySpawnedIds: new Set(["w1"]),
        now: NOW,
      }),
    ).toBe("timeout");
  });

  test("status terminating short-circuits", () => {
    expect(
      computeFreshness({
        row: row({ status: "terminating", signaledAt: NOW - 1000 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("terminating");
  });

  test("status detached short-circuits", () => {
    expect(
      computeFreshness({
        row: row({ status: "detached" }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("detached");
  });

  test("exited + no health override → terminal", () => {
    expect(
      computeFreshness({
        row: row({ status: "exited", endedAt: NOW - 1000, exitCode: 0 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("terminal");
  });

  test("crashed + no health override → terminal", () => {
    expect(
      computeFreshness({
        row: row({ status: "crashed", endedAt: NOW - 1000, exitCode: 1 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("terminal");
  });
});
