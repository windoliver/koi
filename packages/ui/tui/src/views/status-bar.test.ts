import { describe, expect, test } from "bun:test";
import { composeStatusBarText, formatAgentState, formatConnectionStatus } from "./status-bar.js";

describe("formatConnectionStatus", () => {
  test("connected returns green indicator", () => {
    const result = formatConnectionStatus("connected");
    expect(result.indicator).toBe("● connected");
    expect(result.color).toBe("#00FF00");
  });

  test("reconnecting returns yellow indicator", () => {
    const result = formatConnectionStatus("reconnecting");
    expect(result.indicator).toContain("reconnecting");
    expect(result.color).toBe("#FFFF00");
  });

  test("disconnected returns red indicator", () => {
    const result = formatConnectionStatus("disconnected");
    expect(result.indicator).toContain("disconnected");
    expect(result.color).toBe("#FF0000");
  });
});

describe("formatAgentState", () => {
  test("returns state name directly", () => {
    expect(formatAgentState("running")).toBe("running");
    expect(formatAgentState("terminated")).toBe("terminated");
    expect(formatAgentState("idle")).toBe("idle");
  });
});

describe("composeStatusBarText", () => {
  test("includes all sections", () => {
    const text = composeStatusBarText({
      connectionStatus: "connected",
      agentName: "my-agent",
      view: "console",
      agentCount: 3,
    });
    expect(text).toContain("KOI");
    expect(text).toContain("connected");
    expect(text).toContain("3 agents");
    expect(text).toContain("my-agent");
    expect(text).toContain("Enter send");
  });

  test("shows 'no agent' when agentName is undefined", () => {
    const text = composeStatusBarText({
      connectionStatus: "disconnected",
      agentName: undefined,
      view: "agents",
      agentCount: 0,
    });
    expect(text).toContain("no agent");
    expect(text).toContain("0 agents");
  });

  test("shows palette view hints", () => {
    const text = composeStatusBarText({
      connectionStatus: "connected",
      agentName: "a1",
      view: "palette",
      agentCount: 1,
    });
    expect(text).toContain("Esc close");
  });
});
