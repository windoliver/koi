import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { GatewayFrame, Session } from "../types.js";
import type { MockTransport } from "./test-utils.js";
import {
  createMockTransport,
  createTestAuthenticator,
  createTestFrame,
  createTestSession,
  resetTestSeqCounter,
} from "./test-utils.js";

describe("Channel Binding", () => {
  let transport: MockTransport;
  let gw: Gateway;

  beforeEach(() => {
    resetTestSeqCounter();
    transport = createMockTransport();
  });

  afterEach(async () => {
    await gw.stop();
  });

  describe("static config bindings", () => {
    test("loads channel bindings from config at startup", async () => {
      gw = createGateway(
        {
          channelBindings: [
            { channelName: "telegram", agentId: "tg-agent" },
            { channelName: "slack", agentId: "slack-agent" },
          ],
        },
        { transport, auth: createTestAuthenticator() },
      );
      await gw.start(0);

      const bindings = gw.channelBindings();
      expect(bindings.size).toBe(2);
      expect(bindings.get("telegram")).toBe("tg-agent");
      expect(bindings.get("slack")).toBe("slack-agent");
    });
  });

  describe("dynamic bindings", () => {
    test("bindChannel adds a new binding", async () => {
      gw = createGateway({}, { transport, auth: createTestAuthenticator() });
      await gw.start(0);

      gw.bindChannel("discord", "discord-bot");
      expect(gw.channelBindings().get("discord")).toBe("discord-bot");
    });

    test("unbindChannel removes an existing binding", async () => {
      gw = createGateway({}, { transport, auth: createTestAuthenticator() });
      await gw.start(0);

      gw.bindChannel("discord", "discord-bot");
      const removed = gw.unbindChannel("discord");
      expect(removed).toBe(true);
      expect(gw.channelBindings().has("discord")).toBe(false);
    });

    test("unbindChannel returns false for non-existent binding", async () => {
      gw = createGateway({}, { transport, auth: createTestAuthenticator() });
      await gw.start(0);

      expect(gw.unbindChannel("no-such")).toBe(false);
    });

    test("bindChannel overwrites existing binding", async () => {
      gw = createGateway(
        { channelBindings: [{ channelName: "slack", agentId: "old-agent" }] },
        { transport, auth: createTestAuthenticator() },
      );
      await gw.start(0);

      gw.bindChannel("slack", "new-agent");
      expect(gw.channelBindings().get("slack")).toBe("new-agent");
    });
  });

  describe("routing integration", () => {
    test("channel binding overrides pattern routing", async () => {
      gw = createGateway(
        {
          channelBindings: [{ channelName: "telegram", agentId: "tg-agent" }],
          routing: {
            scopingMode: "per-channel-peer",
            bindings: [{ pattern: "telegram:*", agentId: "pattern-agent" }],
          },
        },
        { transport, auth: createTestAuthenticator() },
      );
      await gw.start(0);

      const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];
      gw.onFrame((session, frame) => {
        dispatched.push({ session, frame });
      });

      // Dispatch a frame with telegram routing context
      const session = createTestSession({
        agentId: "fallback",
        routing: { channel: "telegram", peer: "user1" },
      });
      const frame = createTestFrame();
      gw.dispatch(session, frame);

      expect(dispatched).toHaveLength(1);
      // Channel binding should win over pattern binding
      expect(dispatched[0]?.session.agentId).toBe("tg-agent");
    });

    test("falls back to pattern routing when no channel binding matches", async () => {
      gw = createGateway(
        {
          channelBindings: [{ channelName: "telegram", agentId: "tg-agent" }],
          routing: {
            scopingMode: "per-channel-peer",
            bindings: [{ pattern: "slack:*", agentId: "slack-agent" }],
          },
        },
        { transport, auth: createTestAuthenticator() },
      );
      await gw.start(0);

      const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];
      gw.onFrame((session, frame) => {
        dispatched.push({ session, frame });
      });

      const session = createTestSession({
        agentId: "fallback",
        routing: { channel: "slack", peer: "user1" },
      });
      gw.dispatch(session, createTestFrame());

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.session.agentId).toBe("slack-agent");
    });

    test("dynamic binding affects dispatch immediately", async () => {
      gw = createGateway({}, { transport, auth: createTestAuthenticator() });
      await gw.start(0);

      const dispatched: Array<{ session: Session }> = [];
      gw.onFrame((session) => {
        dispatched.push({ session });
      });

      const session = createTestSession({
        agentId: "fallback",
        routing: { channel: "whatsapp" },
      });

      // Before binding — fallback
      gw.dispatch(session, createTestFrame());
      expect(dispatched[0]?.session.agentId).toBe("fallback");

      // Bind channel
      gw.bindChannel("whatsapp", "wa-agent");
      gw.dispatch(session, createTestFrame());
      expect(dispatched[1]?.session.agentId).toBe("wa-agent");

      // Unbind — back to fallback
      gw.unbindChannel("whatsapp");
      gw.dispatch(session, createTestFrame());
      expect(dispatched[2]?.session.agentId).toBe("fallback");
    });
  });
});
