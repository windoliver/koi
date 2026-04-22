import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernanceController, GovernanceSnapshot, SensorReading } from "@koi/core";
import { createGovernanceBridge } from "./governance-bridge.js";

let tmpDir: string;
let alertsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-bridge-"));
  alertsPath = join(tmpDir, "alerts.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeController(snap: GovernanceSnapshot): GovernanceController {
  return {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => {},
    snapshot: () => snap,
    variables: () => new Map(),
    reading: (n) => snap.readings.find((r) => r.name === n),
  };
}

describe("governance-bridge", () => {
  test("dispatches set_governance_snapshot on pollSnapshot", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const snap: GovernanceSnapshot = {
      timestamp: 1,
      healthy: true,
      violations: [],
      readings: [{ name: "turn_count", current: 5, limit: 10, utilization: 0.5 }],
    };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController(snap),
      sessionId: "s1",
      alertsPath,
    });
    bridge.pollSnapshot();
    expect(
      dispatched.find((a) => (a as { kind: string }).kind === "set_governance_snapshot"),
    ).toBeDefined();
    bridge.dispose();
  });

  test("recordAlert appends to JSONL and dispatches add_governance_alert", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const reading: SensorReading = { name: "cost_usd", current: 1.6, limit: 2, utilization: 0.8 };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({
        timestamp: 1,
        healthy: true,
        violations: [],
        readings: [reading],
      }),
      sessionId: "s1",
      alertsPath,
    });
    bridge.recordAlert(0.8, "cost_usd", reading);
    const written = readFileSync(alertsPath, "utf8");
    expect(written).toContain('"variable":"cost_usd"');
    expect(dispatched.some((a) => (a as { kind: string }).kind === "add_governance_alert")).toBe(
      true,
    );
    bridge.dispose();
  });

  test("loadRecentAlerts returns last N from JSONL", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath,
    });
    for (let i = 0; i < 5; i++) {
      bridge.recordAlert(0.8, "cost_usd", {
        name: "cost_usd",
        current: i,
        limit: 10,
        utilization: 0.1 * i,
      });
    }
    const recent = bridge.loadRecentAlerts(3);
    expect(recent).toHaveLength(3);
    bridge.dispose();
  });

  test("loadRecentAlerts returns [] when file does not exist", () => {
    const store = { dispatch: () => {} };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath: join(tmpDir, "nonexistent.jsonl"),
    });
    expect(bridge.loadRecentAlerts(10)).toEqual([]);
    bridge.dispose();
  });

  test("dispatches set_governance_rules and set_governance_capabilities when provided at config", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath,
      rules: [{ id: "r1", description: "too many turns", effect: "advise" }],
      capabilities: [{ label: "file-ops", description: "read/write files" }],
    });
    expect(dispatched.some((a) => (a as { kind: string }).kind === "set_governance_rules")).toBe(
      true,
    );
    expect(
      dispatched.some((a) => (a as { kind: string }).kind === "set_governance_capabilities"),
    ).toBe(true);
    bridge.dispose();
  });

  test("recordViolation dispatches add_governance_violation", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath,
    });
    bridge.recordViolation("cost_usd", "exceeded budget");
    expect(
      dispatched.some((a) => (a as { kind: string }).kind === "add_governance_violation"),
    ).toBe(true);
    bridge.dispose();
  });

  test("setSession updates session id used in subsequent alerts", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const reading: SensorReading = { name: "cost_usd", current: 1.0, limit: 2, utilization: 0.5 };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({
        timestamp: 1,
        healthy: true,
        violations: [],
        readings: [reading],
      }),
      sessionId: "s1",
      alertsPath,
    });
    bridge.setSession("s2");
    bridge.recordAlert(0.5, "cost_usd", reading);
    const written = readFileSync(alertsPath, "utf8");
    const alert = JSON.parse(written.trim()) as { sessionId: string };
    expect(alert.sessionId).toBe("s2");
    bridge.dispose();
  });

  test("pollSnapshot handles async (Promise-returning) controller", async () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const snap: GovernanceSnapshot = { timestamp: 2, healthy: true, violations: [], readings: [] };
    const asyncController: GovernanceController = {
      check: () => ({ ok: true }),
      checkAll: () => ({ ok: true }),
      record: () => {},
      snapshot: () => Promise.resolve(snap),
      variables: () => new Map(),
      reading: () => undefined,
    };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: asyncController,
      sessionId: "s1",
      alertsPath,
    });
    bridge.pollSnapshot();
    // Wait for the microtask queue to flush
    await Promise.resolve();
    expect(
      dispatched.find((a) => (a as { kind: string }).kind === "set_governance_snapshot"),
    ).toBeDefined();
    bridge.dispose();
  });

  test("regression #2016: bridge initializes when runtimeReady resolves before a subsequent await", async () => {
    // Reproduces the Temporal Dead Zone race in tui-command.ts: the
    // runtimeReady.then() callback fires during `await createCostBridge` when
    // runtimeReady is already settled. If `let governanceBridge` were declared
    // AFTER that await, the assignment inside .then() would hit TDZ and throw.
    // The fix: declare governanceBridge BEFORE registering .then().
    const store = { dispatch: () => {} };
    const controller = makeController({
      timestamp: 1,
      healthy: true,
      violations: [],
      readings: [],
    });

    // Declared BEFORE the .then() registration — the fix that prevents TDZ.
    let bridge: ReturnType<typeof createGovernanceBridge> | undefined;
    let initError: unknown;

    // runtimeReady resolves immediately (already-settled promise).
    const runtimeReady = Promise.resolve({ controller });
    runtimeReady.then(({ controller: ctrl }) => {
      try {
        bridge = createGovernanceBridge({
          store: store as never,
          controller: ctrl,
          sessionId: "s-tdz",
          alertsPath,
        });
      } catch (e) {
        initError = e;
      }
    });

    // Simulate the `await createCostBridge(...)` that sits between the .then()
    // registration and the original `let governanceBridge` declaration. When
    // this await yields, the microtask queue drains and the .then() fires.
    await Promise.resolve();

    expect(initError).toBeUndefined();
    expect(bridge).toBeDefined();
    bridge?.dispose();
  });

  test("tailEvict trims JSONL file when it exceeds max lines", () => {
    const store = { dispatch: () => {} };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath,
    });
    // Write 201 alerts (MAX_PERSISTED_ALERTS = 200, so one extra triggers eviction)
    for (let i = 0; i < 201; i++) {
      bridge.recordAlert(0.8, "cost_usd", {
        name: "cost_usd",
        current: i,
        limit: 300,
        utilization: i / 300,
      });
    }
    const lines = readFileSync(alertsPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(200);
    bridge.dispose();
  });
});
