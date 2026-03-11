import { describe, expect, test } from "bun:test";
import { createStatusBar, type StatusBarData } from "./status-bar.js";

describe("createStatusBar", () => {
  test("creates component and update function", () => {
    const bar = createStatusBar();
    expect(bar.component).toBeDefined();
    expect(typeof bar.update).toBe("function");
  });

  test("renders without error", () => {
    const bar = createStatusBar();
    const data: StatusBarData = {
      connectionStatus: "connected",
      agentName: "test-agent",
      view: "agents",
      agentCount: 3,
    };
    bar.update(data);
    // Text component should render to string lines
    const lines = bar.component.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("renders with no agent", () => {
    const bar = createStatusBar();
    bar.update({
      connectionStatus: "disconnected",
      agentName: undefined,
      view: "console",
      agentCount: 0,
    });
    const lines = bar.component.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("renders each connection status", () => {
    const bar = createStatusBar();
    for (const status of ["connected", "reconnecting", "disconnected"] as const) {
      bar.update({
        connectionStatus: status,
        agentName: undefined,
        view: "agents",
        agentCount: 0,
      });
      const lines = bar.component.render(120);
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});
