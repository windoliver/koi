import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentId, SessionId } from "@koi/core";
import type { AnomalyMonitor } from "../monitor.js";
import { createAnomalyMonitor } from "../monitor.js";

const SESSION = "session-1" as SessionId;
const AGENT = "agent-1" as AgentId;

describe("createAnomalyMonitor", () => {
  let monitor: AnomalyMonitor;

  beforeEach(() => {
    monitor = createAnomalyMonitor({
      sessionId: SESSION,
      agentId: AGENT,
      toolRateThreshold: 3,
      errorSpikeThreshold: 2,
      toolRepeatThreshold: 2,
      deniedCallThreshold: 2,
    });
  });

  test("returns no anomalies for first tool call", () => {
    const signals = monitor.recordToolCall({ toolId: "bash" });
    expect(signals).toHaveLength(0);
  });

  test("fires tool_rate_exceeded when threshold is reached", () => {
    monitor.recordToolCall({ toolId: "a" });
    monitor.recordToolCall({ toolId: "b" });
    const signals = monitor.recordToolCall({ toolId: "c" });
    expect(signals.some((s) => s.kind === "tool_rate_exceeded")).toBe(true);
    const sig = signals.find((s) => s.kind === "tool_rate_exceeded");
    expect(sig).toBeDefined();
    if (sig !== undefined && sig.kind === "tool_rate_exceeded") {
      expect(sig.callsPerTurn).toBe(3);
      expect(sig.threshold).toBe(3);
    }
  });

  test("tool_rate_exceeded fires only once per turn crossing", () => {
    monitor.recordToolCall({ toolId: "a" });
    monitor.recordToolCall({ toolId: "b" });
    const first = monitor.recordToolCall({ toolId: "c" }); // crossing
    const second = monitor.recordToolCall({ toolId: "d" }); // above threshold, no re-fire
    expect(first.some((s) => s.kind === "tool_rate_exceeded")).toBe(true);
    expect(second.some((s) => s.kind === "tool_rate_exceeded")).toBe(false);
  });

  test("fires error_spike when error threshold is reached", () => {
    monitor.recordToolCall({ toolId: "a", errored: true });
    const signals = monitor.recordToolCall({ toolId: "b", errored: true });
    expect(signals.some((s) => s.kind === "error_spike")).toBe(true);
    const sig = signals.find((s) => s.kind === "error_spike");
    expect(sig).toBeDefined();
    if (sig !== undefined && sig.kind === "error_spike") {
      expect(sig.errorCount).toBe(2);
      expect(sig.threshold).toBe(2);
    }
  });

  test("fires tool_repeated when same tool hits threshold", () => {
    monitor.recordToolCall({ toolId: "bash" });
    const signals = monitor.recordToolCall({ toolId: "bash" });
    expect(signals.some((s) => s.kind === "tool_repeated")).toBe(true);
    const sig = signals.find((s) => s.kind === "tool_repeated");
    expect(sig).toBeDefined();
    if (sig !== undefined && sig.kind === "tool_repeated") {
      expect(sig.toolId).toBe("bash");
      expect(sig.repeatCount).toBe(2);
    }
  });

  test("fires denied_tool_calls when denied threshold is reached", () => {
    monitor.recordToolCall({ toolId: "a", denied: true });
    const signals = monitor.recordToolCall({ toolId: "b", denied: true });
    expect(signals.some((s) => s.kind === "denied_tool_calls")).toBe(true);
    const sig = signals.find((s) => s.kind === "denied_tool_calls");
    expect(sig).toBeDefined();
    if (sig !== undefined && sig.kind === "denied_tool_calls") {
      expect(sig.deniedCount).toBe(2);
    }
  });

  test("anomaly signals include session + agent metadata", () => {
    monitor.recordToolCall({ toolId: "a" });
    monitor.recordToolCall({ toolId: "b" });
    const signals = monitor.recordToolCall({ toolId: "c" });
    const sig = signals[0];
    expect(sig).toBeDefined();
    if (sig !== undefined) {
      expect(sig.sessionId).toBe(SESSION);
      expect(sig.agentId).toBe(AGENT);
      expect(typeof sig.timestamp).toBe("number");
      expect(sig.turnIndex).toBe(0);
    }
  });

  test("nextTurn resets per-turn counters and increments turnIndex", () => {
    monitor.recordToolCall({ toolId: "a" });
    monitor.recordToolCall({ toolId: "b" });
    monitor.recordToolCall({ toolId: "c" }); // triggers tool_rate_exceeded
    monitor.nextTurn();

    // Fresh turn — no signals yet
    const signals = monitor.recordToolCall({ toolId: "d" });
    expect(signals).toHaveLength(0);

    // turnIndex should now be 1
    monitor.recordToolCall({ toolId: "e" });
    const signals2 = monitor.recordToolCall({ toolId: "f" });
    const rateSig = signals2.find((s) => s.kind === "tool_rate_exceeded");
    expect(rateSig?.turnIndex).toBe(1);
  });

  test("reset returns to initial state with turnIndex 0", () => {
    monitor.recordToolCall({ toolId: "a" });
    monitor.recordToolCall({ toolId: "b" });
    monitor.nextTurn();
    monitor.reset();

    const signals = monitor.recordToolCall({ toolId: "c" });
    expect(signals).toHaveLength(0);
    // Verify turnIndex is back to 0
    monitor.recordToolCall({ toolId: "d" });
    const signals2 = monitor.recordToolCall({ toolId: "e" });
    const rateSig = signals2.find((s) => s.kind === "tool_rate_exceeded");
    expect(rateSig?.turnIndex).toBe(0);
  });

  test("uses default thresholds when not specified", () => {
    const defaultMonitor = createAnomalyMonitor({ sessionId: SESSION, agentId: AGENT });
    // Default denied threshold is 3 — 2 denials should NOT fire
    defaultMonitor.recordToolCall({ toolId: "a", denied: true });
    const s1 = defaultMonitor.recordToolCall({ toolId: "b", denied: true });
    expect(s1.some((s) => s.kind === "denied_tool_calls")).toBe(false);
    // 3rd denial fires
    const s2 = defaultMonitor.recordToolCall({ toolId: "c", denied: true });
    expect(s2.some((s) => s.kind === "denied_tool_calls")).toBe(true);
  });
});
