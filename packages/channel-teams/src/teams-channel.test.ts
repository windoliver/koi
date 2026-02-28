import { describe, expect, mock, test } from "bun:test";
import { testChannelAdapter } from "@koi/test-utils";
import type { TeamsActivity } from "./activity-types.js";
import { createTeamsChannel } from "./teams-channel.js";

function makeAdapter(): ReturnType<typeof createTeamsChannel> {
  return createTeamsChannel({
    appId: "test-app-id",
    appPassword: "test-app-password",
    _agent: {}, // Skip real server setup
  });
}

describe("createTeamsChannel", () => {
  describe("contract tests", () => {
    testChannelAdapter({
      createAdapter: () => makeAdapter(),
    });
  });

  describe("capabilities", () => {
    test("declares expected capabilities", () => {
      const adapter = makeAdapter();
      expect(adapter.capabilities).toEqual({
        text: true,
        images: true,
        files: true,
        buttons: true,
        audio: false,
        video: false,
        threads: true,
        supportsA2ui: false,
      });
    });

    test("name is 'teams'", () => {
      const adapter = makeAdapter();
      expect(adapter.name).toBe("teams");
    });
  });

  describe("lifecycle", () => {
    test("connect and disconnect complete without error", async () => {
      const adapter = makeAdapter();
      await adapter.connect();
      await adapter.disconnect();
    });
  });

  describe("handleActivity", () => {
    test("handleActivity is present", () => {
      const adapter = makeAdapter();
      expect(adapter.handleActivity).toBeDefined();
      expect(typeof adapter.handleActivity).toBe("function");
    });

    test("handleActivity dispatches message to handler", async () => {
      const adapter = makeAdapter();
      const received = new Promise<string>((resolve) => {
        adapter.onMessage(async (msg) => {
          const textBlock = msg.content.find((b) => b.kind === "text");
          if (textBlock !== undefined && textBlock.kind === "text") {
            resolve(textBlock.text);
          }
        });
      });

      await adapter.connect();

      const activity: TeamsActivity = {
        type: "message",
        id: "act-1",
        text: "hello from teams",
        from: { id: "user-1", name: "User" },
        conversation: { id: "conv-1" },
      };

      await adapter.handleActivity?.(activity);

      const text = await received;
      expect(text).toBe("hello from teams");

      await adapter.disconnect();
    });

    test("handleActivity ignores bot's own messages", async () => {
      const adapter = createTeamsChannel({
        appId: "bot-id",
        appPassword: "password",
        _agent: {},
      });

      const handler = mock(async () => {});
      adapter.onMessage(handler);
      await adapter.connect();

      const activity: TeamsActivity = {
        type: "message",
        text: "bot echo",
        from: { id: "bot-id", name: "Bot" },
        conversation: { id: "conv-1" },
      };

      await adapter.handleActivity?.(activity);
      await Bun.sleep(50);

      expect(handler).not.toHaveBeenCalled();
      await adapter.disconnect();
    });

    test("stores conversation reference from activity with serviceUrl", async () => {
      const adapter = makeAdapter();
      await adapter.connect();

      const activity: TeamsActivity = {
        type: "message",
        text: "hello",
        from: { id: "user-1", name: "User" },
        conversation: { id: "conv-1", tenantId: "tenant-1" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      };

      await adapter.handleActivity?.(activity);

      const refs = adapter.conversationReferences();
      expect(refs.size).toBe(1);
      const ref = refs.get("conv-1");
      expect(ref?.conversationId).toBe("conv-1");
      expect(ref?.serviceUrl).toBe("https://smba.trafficmanager.net/teams/");
      expect(ref?.botId).toBe("test-app-id");
      expect(ref?.tenantId).toBe("tenant-1");

      await adapter.disconnect();
    });

    test("clears conversation references on disconnect", async () => {
      const adapter = makeAdapter();
      await adapter.connect();

      await adapter.handleActivity?.({
        type: "message",
        text: "hello",
        from: { id: "user-1" },
        conversation: { id: "conv-1" },
        serviceUrl: "https://example.com/",
      });

      expect(adapter.conversationReferences().size).toBe(1);
      await adapter.disconnect();
      expect(adapter.conversationReferences().size).toBe(0);
    });

    test("handleActivity ignores non-message activities", async () => {
      const adapter = makeAdapter();
      const handler = mock(async () => {});
      adapter.onMessage(handler);
      await adapter.connect();

      const activity: TeamsActivity = {
        type: "conversationUpdate",
        from: { id: "user-1" },
        conversation: { id: "conv-1" },
      };

      await adapter.handleActivity?.(activity);
      await Bun.sleep(50);

      expect(handler).not.toHaveBeenCalled();
      await adapter.disconnect();
    });
  });
});
