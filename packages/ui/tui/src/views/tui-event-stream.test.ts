import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state/types.js";
import {
  formatAgentEvent,
  formatDataSourceEvent,
  getDomainScrollOffset,
  viewToDomainKey,
} from "./tui-event-stream.js";

describe("viewToDomainKey", () => {
  test("maps skills view to skills", () => {
    expect(viewToDomainKey("skills")).toBe("skills");
  });

  test("maps temporal view to temporal", () => {
    expect(viewToDomainKey("temporal")).toBe("temporal");
  });

  test("returns null for non-domain views", () => {
    expect(viewToDomainKey("agents")).toBeNull();
    expect(viewToDomainKey("console")).toBeNull();
    expect(viewToDomainKey("palette")).toBeNull();
  });
});

describe("getDomainScrollOffset", () => {
  test("returns 0 for initial state", () => {
    const state = createInitialState("http://localhost:3100");
    expect(getDomainScrollOffset(state, "skills")).toBe(0);
    expect(getDomainScrollOffset(state, "temporal")).toBe(0);
  });

  test("returns 0 for unknown domain", () => {
    const state = createInitialState("http://localhost:3100");
    expect(getDomainScrollOffset(state, "unknown")).toBe(0);
  });
});

describe("formatAgentEvent", () => {
  test("formats status_changed", () => {
    const result = formatAgentEvent({
      kind: "agent",
      subKind: "status_changed",
      agentId: "a-1" as import("@koi/core").AgentId,
      from: "created" as import("@koi/core").ProcessState,
      to: "running" as import("@koi/core").ProcessState,
      timestamp: Date.now(),
    });
    expect(result).toContain("created");
    expect(result).toContain("running");
  });

  test("formats dispatched", () => {
    const result = formatAgentEvent({
      kind: "agent",
      subKind: "dispatched",
      agentId: "a-1" as import("@koi/core").AgentId,
      name: "test-agent",
      agentType: "copilot",
      timestamp: Date.now(),
    });
    expect(result).toContain("test-agent");
  });

  test("returns null for unknown subKind", () => {
    const result = formatAgentEvent({
      kind: "agent",
      subKind: "unknown" as "dispatched",
      agentId: "a-1" as import("@koi/core").AgentId,
      name: "x",
      agentType: "copilot",
      timestamp: Date.now(),
    });
    // Unknown subKind falls through default
    expect(result).toBeNull();
  });
});

describe("formatDataSourceEvent", () => {
  test("formats data_source_discovered", () => {
    const result = formatDataSourceEvent({
      kind: "datasource",
      subKind: "data_source_discovered",
      name: "my-db",
      protocol: "postgres",
      source: "env",
      timestamp: Date.now(),
    });
    expect(result).toContain("my-db");
    expect(result).toContain("postgres");
  });

  test("formats connector_forged", () => {
    const result = formatDataSourceEvent({
      kind: "datasource",
      subKind: "connector_forged",
      name: "my-db",
      protocol: "postgres",
      timestamp: Date.now(),
    });
    expect(result).toContain("Connector forged");
  });
});
