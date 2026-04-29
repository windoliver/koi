import { describe, expect, test } from "bun:test";
import type { Gateway, GatewayFrame, GatewayFrameKind, RoutingContext, Session } from "./types.js";

describe("@koi/gateway-types — type shapes", () => {
  test("GatewayFrame satisfies shape at runtime", () => {
    const frame: GatewayFrame = {
      kind: "request" satisfies GatewayFrameKind,
      id: "f-1",
      seq: 0,
      payload: { action: "ping" },
      timestamp: 1000,
    };
    expect(frame.kind).toBe("request");
    expect(frame.id).toBe("f-1");
    expect(frame.seq).toBe(0);
    expect(frame.ref).toBeUndefined();
    expect(frame.payload).toEqual({ action: "ping" });
  });

  test("GatewayFrame with optional ref field", () => {
    const frame: GatewayFrame = {
      kind: "response" satisfies GatewayFrameKind,
      id: "f-2",
      seq: 1,
      ref: "f-1",
      payload: null,
      timestamp: 2000,
    };
    expect(frame.ref).toBe("f-1");
  });

  test("RoutingContext all fields optional", () => {
    const empty: RoutingContext = {};
    expect(empty.channel).toBeUndefined();
    expect(empty.account).toBeUndefined();
    expect(empty.peer).toBeUndefined();

    const full: RoutingContext = { channel: "slack", account: "acme", peer: "bot-1" };
    expect(full.channel).toBe("slack");
    expect(full.account).toBe("acme");
    expect(full.peer).toBe("bot-1");
  });

  test("Session satisfies shape at runtime", () => {
    const session: Session = {
      id: "s-1",
      agentId: "a-1",
      connectedAt: 1000,
      lastHeartbeat: 2000,
      seq: 5,
      remoteSeq: 3,
      metadata: { env: "test" },
    };
    expect(session.id).toBe("s-1");
    expect(session.agentId).toBe("a-1");
    expect(session.routing).toBeUndefined();
  });

  test("Session with routing context", () => {
    const session: Session = {
      id: "s-2",
      agentId: "a-2",
      connectedAt: 0,
      lastHeartbeat: 0,
      seq: 0,
      remoteSeq: 0,
      metadata: {},
      routing: { channel: "github", account: "org-1" },
    };
    expect(session.routing?.channel).toBe("github");
    expect(session.routing?.account).toBe("org-1");
  });

  test("all GatewayFrameKind values are string literals", () => {
    const kinds: GatewayFrameKind[] = ["request", "response", "event", "ack", "error"];
    expect(kinds).toHaveLength(5);
    for (const k of kinds) {
      expect(typeof k).toBe("string");
    }
  });
});

describe("Gateway contract", () => {
  test("can be implemented by a minimal stub", () => {
    const stub: Gateway = {
      ingest(_s: Session, _f: GatewayFrame) {},
      pauseIngress() {},
      forceClose() {},
      activeConnections: () => 0,
    };
    expect(stub.activeConnections()).toBe(0);
  });

  test("activeConnections may be async", async () => {
    const stub: Gateway = {
      ingest() {},
      pauseIngress() {},
      forceClose() {},
      activeConnections: async () => 5,
    };
    expect(await stub.activeConnections()).toBe(5);
  });
});
