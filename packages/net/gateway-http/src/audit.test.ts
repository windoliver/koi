import { describe, expect, test } from "bun:test";
import { buildGatewayRequestEntry } from "./audit.js";

describe("buildGatewayRequestEntry", () => {
  test("includes required fields", () => {
    const entry = buildGatewayRequestEntry({
      timestamp: 1730000000000,
      kind: "gateway.request",
      channel: "slack",
      path: "/webhooks/slack/T1",
      method: "POST",
      status: 200,
      latencyMs: 12,
      authResult: "ok",
      sessionId: "sess1",
      remoteAddr: "1.2.3.4",
    });
    expect(entry.kind).toBe("gateway.request");
    expect(entry.metadata).toMatchObject({
      channel: "slack",
      path: "/webhooks/slack/T1",
      method: "POST",
      status: 200,
      authResult: "ok",
      remoteAddr: "1.2.3.4",
    });
    expect(entry.durationMs).toBe(12);
  });

  test("omits optional fields when not provided", () => {
    const entry = buildGatewayRequestEntry({
      timestamp: 1730000000000,
      kind: "gateway.request",
      path: "/healthz",
      method: "GET",
      status: 200,
      latencyMs: 1,
      authResult: "skipped",
    });
    expect(entry.metadata).not.toHaveProperty("channel");
    expect(entry.metadata).not.toHaveProperty("remoteAddr");
  });
});
