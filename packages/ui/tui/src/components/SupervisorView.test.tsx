/**
 * SupervisorView tests — pure helpers + component smoke tests.
 */

import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core/ecs";
import type { SupervisorHealth, SupervisorHealthMetrics, WorkerHealth } from "@koi/core/daemon";
import { workerId } from "@koi/core/daemon";
import type { BridgeStatus, SupervisorSlice } from "../state/types.js";
import {
  formatMetricsRow,
  formatStatusBanner,
  formatWorkerRow,
  SupervisorView,
} from "./SupervisorView.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

const metrics: SupervisorHealthMetrics = {
  poolSize: 3,
  maxWorkers: 10,
  quarantinedCount: 1,
  restartingCount: 0,
  pendingSpawnCount: 2,
  eventDropCount: 5,
  shuttingDown: false,
};

const worker: WorkerHealth = {
  workerId: workerId("w-1"),
  agentId: "agent-abc" as AgentId,
  state: "running",
  lastHeartbeatAt: NOW - 3000,
  heartbeatDeadlineAt: NOW + 5000,
};

const health: SupervisorHealth = {
  status: "ok",
  reasons: [],
  metrics,
  workers: [worker],
};

const healthDegraded: SupervisorHealth = {
  status: "degraded",
  reasons: ["worker w-2 missed heartbeat"],
  metrics,
  workers: [],
};

const emptySlice: SupervisorSlice = {
  attached: false,
  status: { kind: "detached" },
  health: null,
  events: [],
};

const attachedSlice: SupervisorSlice = {
  attached: true,
  status: { kind: "live" },
  health,
  events: [
    { id: "e1", ts: NOW - 5000, kind: "started", workerId: "w-1", agentName: "ResearchAgent" },
    {
      id: "e2",
      ts: NOW - 2000,
      kind: "heartbeat",
      workerId: "w-1",
      agentName: "ResearchAgent",
      detail: "ok",
    },
  ],
};

const OPTS = { width: 120, height: 40 } as const;

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("SupervisorView pure helpers", () => {
  describe("formatStatusBanner", () => {
    test("live → null (no banner)", () => {
      expect(formatStatusBanner({ kind: "live" }, NOW)).toBeNull();
    });

    test("detached → null (no banner)", () => {
      expect(formatStatusBanner({ kind: "detached" }, NOW)).toBeNull();
    });

    test("stale → red text with reason and elapsed seconds", () => {
      const status: BridgeStatus = {
        kind: "stale",
        since: NOW - 12_000,
        reason: "watchAll iterator closed",
      };
      const result = formatStatusBanner(status, NOW);
      expect(result).not.toBeNull();
      expect(result?.color).toBe("#EF4444"); // COLORS.red
      expect(result?.text).toContain("watchAll iterator closed");
      expect(result?.text).toContain("12s ago");
    });

    test("degraded → amber with missing channels and elapsed seconds", () => {
      const status: BridgeStatus = {
        kind: "degraded",
        missing: ["workerEvents", "registryEvents"],
        since: NOW - 4_000,
      };
      const result = formatStatusBanner(status, NOW);
      expect(result).not.toBeNull();
      expect(result?.color).toBe("#FBBF24"); // COLORS.amber
      expect(result?.text).toContain("workerEvents");
      expect(result?.text).toContain("registryEvents");
      expect(result?.text).toContain("4s ago");
    });

    test("degraded with single missing channel", () => {
      const status: BridgeStatus = {
        kind: "degraded",
        missing: ["workerEvents"],
        since: NOW - 1_000,
      };
      const result = formatStatusBanner(status, NOW);
      expect(result?.text).toContain("workerEvents");
      expect(result?.text).not.toContain("registryEvents");
    });
  });

  describe("formatMetricsRow", () => {
    test("renders all fields", () => {
      const row = formatMetricsRow(metrics);
      expect(row).toContain("3/10 workers");
      expect(row).toContain("quarantined: 1");
      expect(row).toContain("restarting: 0");
      expect(row).toContain("pendingSpawn: 2");
      expect(row).toContain("eventDrops: 5");
      expect(row).toContain("shuttingDown: no");
    });

    test("shuttingDown: yes when true", () => {
      const row = formatMetricsRow({ ...metrics, shuttingDown: true });
      expect(row).toContain("shuttingDown: yes");
    });
  });

  describe("formatWorkerRow", () => {
    test("renders heartbeat ages correctly", () => {
      const row = formatWorkerRow(worker, NOW);
      expect(row.workerId).toBe("w-1");
      expect(row.agentId).toBe("agent-abc");
      expect(row.state).toBe("running");
      expect(row.lastHb).toContain("s ago");
      expect(row.deadline).toContain("s ago");
    });

    test("renders — for undefined heartbeat fields", () => {
      const noHb: WorkerHealth = {
        workerId: workerId("w-2"),
        agentId: "agent-xyz" as AgentId,
        state: "quarantined",
        lastHeartbeatAt: undefined,
        heartbeatDeadlineAt: undefined,
      };
      const row = formatWorkerRow(noHb, NOW);
      expect(row.lastHb).toBe("—");
      expect(row.deadline).toBe("—");
    });

    test("renders ms ago for sub-second heartbeat", () => {
      const freshWorker: WorkerHealth = {
        ...worker,
        lastHeartbeatAt: NOW - 200,
        heartbeatDeadlineAt: NOW - 100,
      };
      const row = formatWorkerRow(freshWorker, NOW);
      expect(row.lastHb).toContain("ms ago");
    });
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe("SupervisorView component", () => {
  test("empty state when attached === false", async () => {
    const utils = await testRender(() => <SupervisorView slice={emptySlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("No supervisor attached");
    expect(frame).toContain("supervision:");
    utils.renderer.destroy();
  });

  test("renders Supervisor heading", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Supervisor");
    utils.renderer.destroy();
  });

  test("renders worker table when health populated", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Workers");
    expect(frame).toContain("w-1");
    expect(frame).toContain("running");
    utils.renderer.destroy();
  });

  test("hides reasons section when health.reasons empty", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    // health.reasons is [] so no bullet should appear
    expect(utils.captureCharFrame()).not.toContain("•");
    utils.renderer.destroy();
  });

  test("renders reasons when degraded health", async () => {
    const slice: SupervisorSlice = { ...attachedSlice, health: healthDegraded };
    const utils = await testRender(() => <SupervisorView slice={slice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("missed heartbeat");
    utils.renderer.destroy();
  });

  test("renders event feed newest-first", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    // Both events should appear; newest (e2) listed first
    expect(frame).toContain("heartbeat");
    expect(frame).toContain("started");
    // heartbeat event (ts=NOW-2000) should appear before started (ts=NOW-5000)
    const hbIdx = frame.indexOf("heartbeat");
    const startedIdx = frame.indexOf("started");
    expect(hbIdx).toBeLessThan(startedIdx);
    utils.renderer.destroy();
  });

  test("renders 'observability stale' banner when status.kind === stale", async () => {
    const staleSlice: SupervisorSlice = {
      ...attachedSlice,
      status: { kind: "stale", since: Date.now() - 5000, reason: "poll timeout" },
    };
    const utils = await testRender(() => <SupervisorView slice={staleSlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Observability stale");
    expect(frame).toContain("poll timeout");
    utils.renderer.destroy();
  });

  test("renders Loading placeholder when attached but health is null", async () => {
    const loadingSlice: SupervisorSlice = {
      attached: true,
      status: { kind: "live" },
      health: null,
      events: [],
    };
    const utils = await testRender(() => <SupervisorView slice={loadingSlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Loading");
    utils.renderer.destroy();
  });

  test("renders metrics row", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("3/10 workers");
    utils.renderer.destroy();
  });

  test("renders 'No events yet' when event feed empty", async () => {
    const noEvents: SupervisorSlice = { ...attachedSlice, events: [] };
    const utils = await testRender(() => <SupervisorView slice={noEvents} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("No events yet");
    utils.renderer.destroy();
  });

  test("renders Esc to close hint", async () => {
    const utils = await testRender(() => <SupervisorView slice={attachedSlice} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Esc to close");
    utils.renderer.destroy();
  });
});
