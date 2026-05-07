/**
 * BgView tests — pure helpers + component smoke tests (#1944).
 */

import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import type { BgSessionRow, BgSessionsSlice, RegistryStatus } from "../state/types.js";
import {
  BgView,
  formatBgRow,
  formatRegistryBanner,
  freshnessColor,
  isKillEligible,
  killHintFor,
} from "./BgView.js";
import { COLORS } from "../theme.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeRow(overrides: Partial<BgSessionRow> = {}): BgSessionRow {
  return {
    workerId: "w-abc123",
    agentId: "agent-xyz",
    sessionId: "sess-1",
    status: "running",
    pid: 12345,
    startedAt: NOW - 60_000,
    endedAt: null,
    exitCode: null,
    lastHeartbeatAt: NOW - 1000,
    heartbeatDeadlineAt: NOW + 5000,
    logPath: "/var/log/koi/w-abc123.log",
    backendKind: "subprocess",
    version: 1,
    signaledAt: null,
    freshness: "ok",
    ...overrides,
  };
}

function makeSlice(overrides: Partial<BgSessionsSlice> = {}): BgSessionsSlice {
  return {
    rows: [],
    registryStatus: { kind: "live" },
    tailingWorkerId: null,
    killConfirm: null,
    ...overrides,
  };
}

const OPTS = { width: 160, height: 40 } as const;
const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// isKillEligible
// ---------------------------------------------------------------------------

describe("isKillEligible", () => {
  test("ok / pending / stale / timeout / unmonitored / restarting / quarantined / stopping → true", () => {
    const eligible: BgSessionRow["freshness"][] = [
      "ok",
      "pending",
      "stale",
      "timeout",
      "unmonitored",
      "restarting",
      "quarantined",
      "stopping",
    ];
    for (const freshness of eligible) {
      expect(isKillEligible(makeRow({ freshness }))).toBe(true);
    }
  });

  test("foreign / terminating / detached / terminal → false", () => {
    const ineligible: BgSessionRow["freshness"][] = [
      "foreign",
      "terminating",
      "detached",
      "terminal",
    ];
    for (const freshness of ineligible) {
      expect(isKillEligible(makeRow({ freshness }))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// freshnessColor
// ---------------------------------------------------------------------------

describe("freshnessColor", () => {
  test("mapping per spec", () => {
    expect(freshnessColor("ok", COLORS)).toBe(COLORS.success);
    expect(freshnessColor("stale", COLORS)).toBe(COLORS.amber);
    expect(freshnessColor("restarting", COLORS)).toBe(COLORS.amber);
    expect(freshnessColor("stopping", COLORS)).toBe(COLORS.amber);
    expect(freshnessColor("terminating", COLORS)).toBe(COLORS.amber);
    expect(freshnessColor("timeout", COLORS)).toBe(COLORS.danger);
    expect(freshnessColor("quarantined", COLORS)).toBe(COLORS.danger);
    expect(freshnessColor("detached", COLORS)).toBe(COLORS.blue);
    expect(freshnessColor("pending", COLORS)).toBe(COLORS.textMuted);
    expect(freshnessColor("unmonitored", COLORS)).toBe(COLORS.textMuted);
    expect(freshnessColor("foreign", COLORS)).toBe(COLORS.textMuted);
    expect(freshnessColor("terminal", COLORS)).toBe(COLORS.textMuted);
  });
});

// ---------------------------------------------------------------------------
// formatBgRow
// ---------------------------------------------------------------------------

describe("formatBgRow", () => {
  test("renders age in seconds", () => {
    const row = makeRow({ startedAt: NOW - 45_000 });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.age).toBe("45s ago");
  });

  test("renders age in minutes", () => {
    const row = makeRow({ startedAt: NOW - 150_000 });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.age).toBe("2m ago");
  });

  test("renders age in hours", () => {
    const row = makeRow({ startedAt: NOW - 7_200_000 });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.age).toBe("2h ago");
  });

  test("truncates long logPath", () => {
    const longPath = "/very/long/path/to/some/directory/with/a/deeply/nested/log/file.log";
    const row = makeRow({ logPath: longPath });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.logPath.length).toBeLessThanOrEqual(28);
    expect(formatted.logPath.startsWith("…")).toBe(true);
  });

  test("renders (none) for empty logPath", () => {
    const row = makeRow({ logPath: "" });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.logPath).toBe("(none)");
  });

  test("renders short logPath without truncation", () => {
    const row = makeRow({ logPath: "/tmp/koi.log" });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.logPath).toBe("/tmp/koi.log");
  });

  test("renders workerId, agentId, status, pid", () => {
    const row = makeRow({ workerId: "w-test", agentId: "agent-99", status: "running", pid: 42 });
    const formatted = formatBgRow(row, NOW);
    expect(formatted.workerId).toBe("w-test");
    expect(formatted.agentId).toBe("agent-99");
    expect(formatted.status).toBe("running");
    expect(formatted.pid).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// formatRegistryBanner
// ---------------------------------------------------------------------------

describe("formatRegistryBanner", () => {
  test("live → null", () => {
    expect(formatRegistryBanner({ kind: "live" }, NOW)).toBeNull();
  });

  test("stale → red with reason and secs", () => {
    const status: RegistryStatus = { kind: "stale", since: NOW - 12_000, reason: "poll error" };
    const result = formatRegistryBanner(status, NOW);
    expect(result).not.toBeNull();
    expect(result?.color).toBe(COLORS.red);
    expect(result?.text).toContain("poll error");
    expect(result?.text).toContain("12s");
    expect(result?.text).toContain("preserved last snapshot");
  });

  test("degraded → amber with secs", () => {
    const status: RegistryStatus = { kind: "degraded", since: NOW - 7_000 };
    const result = formatRegistryBanner(status, NOW);
    expect(result).not.toBeNull();
    expect(result?.color).toBe(COLORS.amber);
    expect(result?.text).toContain("7s");
    expect(result?.text).toContain("polls live");
  });
});

// ---------------------------------------------------------------------------
// killHintFor
// ---------------------------------------------------------------------------

describe("killHintFor", () => {
  test("isTailing → stop tailing hint", () => {
    const row = makeRow({ freshness: "ok" });
    expect(killHintFor(row, true)).toContain("stop tailing");
  });

  test("foreign row → 'use koi bg kill'", () => {
    const row = makeRow({ freshness: "foreign" });
    const hint = killHintFor(row, false);
    expect(hint).toContain("koi bg kill");
    expect(hint).toContain("read-only");
  });

  test("terminal row → 'already terminal'", () => {
    const row = makeRow({ freshness: "terminal" });
    const hint = killHintFor(row, false);
    expect(hint).toContain("already terminal");
  });

  test("empty logPath → 'logging disabled'", () => {
    const row = makeRow({ freshness: "ok", logPath: "" });
    const hint = killHintFor(row, false);
    expect(hint).toContain("logging disabled");
  });

  test("kill-eligible row with logPath → kill hint", () => {
    const row = makeRow({ freshness: "ok", logPath: "/tmp/koi.log" });
    const hint = killHintFor(row, false);
    expect(hint).toContain("[k] kill");
    expect(hint).toContain("[Enter] tail logs");
    expect(hint).toContain("[Esc] back");
  });

  test("locally-spawned pending row → kill-eligible hint", () => {
    const row = makeRow({ freshness: "pending", logPath: "/tmp/koi.log" });
    const hint = killHintFor(row, false);
    expect(hint).toContain("[k] kill");
  });

  test("terminating row (not eligible) → hint without kill", () => {
    const row = makeRow({ freshness: "terminating", logPath: "/tmp/koi.log" });
    const hint = killHintFor(row, false);
    expect(hint).not.toContain("[k] kill");
    expect(hint).toContain("[Esc] back");
  });
});

// ---------------------------------------------------------------------------
// BgView component smoke tests
// ---------------------------------------------------------------------------

describe("BgView component", () => {
  test("empty state when bg.rows is empty", async () => {
    const slice = makeSlice({ rows: [] });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("No background sessions");
    utils.renderer.destroy();
  });

  test("renders rows + freshness colors", async () => {
    const rows = [
      makeRow({ workerId: "w-001", freshness: "ok", status: "running" }),
      makeRow({ workerId: "w-002", freshness: "stale", status: "running" }),
    ];
    const slice = makeSlice({ rows });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("w-001");
    expect(frame).toContain("w-002");
    expect(frame).toContain("ok");
    expect(frame).toContain("stale");
    utils.renderer.destroy();
  });

  test("registry-stale banner shown when bg.registryStatus.kind === 'stale'", async () => {
    const slice = makeSlice({
      rows: [],
      registryStatus: { kind: "stale", since: NOW - 5000, reason: "timeout" },
    });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Registry unreadable");
    expect(frame).toContain("timeout");
    utils.renderer.destroy();
  });

  test("no banner when registryStatus is live", async () => {
    const slice = makeSlice({ rows: [], registryStatus: { kind: "live" } });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).not.toContain("Registry unreadable");
    expect(frame).not.toContain("events down");
    utils.renderer.destroy();
  });

  test("kill confirm modal renders when bg.killConfirm is set", async () => {
    const row = makeRow({ workerId: "w-kill", pid: 99999, status: "running" });
    const slice = makeSlice({
      rows: [row],
      killConfirm: { workerId: "w-kill", version: 1, pid: 99999 },
    });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Kill worker w-kill");
    expect(frame).toContain("99999");
    expect(frame).toContain("[y]es");
    utils.renderer.destroy();
  });

  test("kill confirm modal NOT shown when killConfirm is null", async () => {
    const row = makeRow({ workerId: "w-001" });
    const slice = makeSlice({ rows: [row], killConfirm: null });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).not.toContain("Kill worker");
    utils.renderer.destroy();
  });

  test("degraded registry banner shown", async () => {
    const slice = makeSlice({
      rows: [],
      registryStatus: { kind: "degraded", since: NOW - 3000 },
    });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Registry events down");
    utils.renderer.destroy();
  });

  test("renders BgView heading", async () => {
    const slice = makeSlice({ rows: [] });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Background Sessions");
    utils.renderer.destroy();
  });

  test("renders table header columns when rows present", async () => {
    const slice = makeSlice({ rows: [makeRow()] });
    const utils = await testRender(() => <BgView slice={slice} onCommand={noop} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("freshness");
    expect(frame).toContain("workerId");
    expect(frame).toContain("agentId");
    utils.renderer.destroy();
  });
});
