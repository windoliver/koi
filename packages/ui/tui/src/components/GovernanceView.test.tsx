/**
 * GovernanceView tests — full-screen sensor / alerts / rules / capabilities view (gov-9).
 */

import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import type { GovernanceSlice } from "../state/types.js";
import { GovernanceView } from "./GovernanceView.js";

const OPTS = { width: 100, height: 40 } as const;

const seed: GovernanceSlice = {
  snapshot: {
    timestamp: 1,
    healthy: true,
    violations: [],
    readings: [
      { name: "turn_count", current: 12, limit: 50, utilization: 0.24 },
      { name: "cost_usd", current: 1.6, limit: 2.0, utilization: 0.8 },
    ],
  },
  alerts: [
    { id: "a1", ts: 1, sessionId: "s1", variable: "cost_usd", threshold: 0.8, current: 1.6, limit: 2, utilization: 0.8 },
  ],
  violations: [],
  rules: [{ id: "r1", description: "block rm -rf", effect: "deny" }],
  capabilities: [{ label: "governance", description: "tracks 5 sensors" }],
};

describe("GovernanceView", () => {
  test("renders 'Governance' heading", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Governance");
    utils.renderer.destroy();
  });

  test("renders sensor table with readings", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Variable");
    expect(frame).toContain("turn_count");
    expect(frame).toContain("12 / 50");
    expect(frame).toContain("cost_usd");
    expect(frame).toContain("80%");
    utils.renderer.destroy();
  });

  test("renders Recent alerts section with one alert", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Recent alerts");
    expect(frame).toContain("cost_usd");
    expect(frame).toContain("80%");
    utils.renderer.destroy();
  });

  test("renders Active rules when rules present", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Active rules");
    expect(frame).toContain("block rm -rf");
    expect(frame).toContain("[deny]");
    utils.renderer.destroy();
  });

  test("omits Active rules section when empty", async () => {
    const utils = await testRender(
      () => <GovernanceView slice={{ ...seed, rules: [] }} />,
      OPTS,
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).not.toContain("Active rules");
    utils.renderer.destroy();
  });

  test("renders Middleware capabilities section", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Middleware capabilities");
    expect(frame).toContain("governance");
    expect(frame).toContain("tracks 5 sensors");
    utils.renderer.destroy();
  });

  test("shows empty state when no snapshot AND no other data", async () => {
    const utils = await testRender(
      () => (
        <GovernanceView
          slice={{ snapshot: null, alerts: [], violations: [], rules: [], capabilities: [] }}
        />
      ),
      OPTS,
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("No governance data");
    utils.renderer.destroy();
  });

  test("renders Esc-to-close hint", async () => {
    const utils = await testRender(() => <GovernanceView slice={seed} />, OPTS);
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Esc to close");
    utils.renderer.destroy();
  });
});
