import { describe, expect, test } from "bun:test";
import type { DashboardEventBatch } from "@koi/dashboard-types";
import type { SseConnectionState } from "./sse-client.js";

// Note: Full EventSource testing requires a browser environment.
// These tests verify the module exports and types compile correctly.
// Integration testing of SSE is done in dashboard-api.

describe("sse-client types", () => {
  test("SseConnectionState union covers all states", () => {
    const states: readonly SseConnectionState[] = ["connected", "reconnecting", "disconnected"];
    expect(states).toHaveLength(3);
  });

  test("DashboardEventBatch shape is valid", () => {
    const batch: DashboardEventBatch = {
      events: [],
      seq: 1,
      timestamp: Date.now(),
    };
    expect(batch.seq).toBe(1);
    expect(batch.events).toHaveLength(0);
  });
});
