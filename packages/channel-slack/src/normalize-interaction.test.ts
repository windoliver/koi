import { describe, expect, test } from "bun:test";
import type { SlackBlockAction, SlackSlashCommand } from "./normalize.js";
import { normalizeInteraction } from "./normalize-interaction.js";

describe("normalizeInteraction", () => {
  describe("slash commands", () => {
    test("normalizes slash command with text", () => {
      const command: SlackSlashCommand = {
        command: "/deploy",
        text: "production",
        user_id: "U123",
        channel_id: "C456",
        trigger_id: "T789",
        response_url: "https://hooks.slack.com/response/xxx",
      };
      const result = normalizeInteraction({ kind: "slash_command", command });

      expect(result).not.toBeNull();
      expect(result?.content).toEqual([{ kind: "text", text: "/deploy production" }]);
      expect(result?.senderId).toBe("U123");
      expect(result?.threadId).toBe("C456");
      expect(result?.metadata?.isSlashCommand).toBe(true);
      expect(result?.metadata?.commandName).toBe("/deploy");
    });

    test("normalizes slash command without text", () => {
      const command: SlackSlashCommand = {
        command: "/status",
        text: "",
        user_id: "U123",
        channel_id: "C456",
        trigger_id: "T789",
        response_url: "https://hooks.slack.com/response/xxx",
      };
      const result = normalizeInteraction({ kind: "slash_command", command });

      expect(result?.content).toEqual([{ kind: "text", text: "/status" }]);
    });
  });

  describe("block actions", () => {
    test("normalizes button action", () => {
      const action: SlackBlockAction = {
        type: "button",
        action_id: "approve_btn",
        block_id: "B1",
        value: "approve",
        user: { id: "U123" },
        channel: { id: "C456" },
      };
      const result = normalizeInteraction({ kind: "block_action", action });

      expect(result).not.toBeNull();
      expect(result?.content).toEqual([
        { kind: "button", label: "approve_btn", action: "approve_btn", payload: "approve" },
      ]);
      expect(result?.senderId).toBe("U123");
      expect(result?.threadId).toBe("C456");
    });

    test("returns null when channel is missing", () => {
      const action: SlackBlockAction = {
        type: "button",
        action_id: "btn",
        block_id: "B1",
        user: { id: "U123" },
      };
      const result = normalizeInteraction({ kind: "block_action", action });

      expect(result).toBeNull();
    });
  });
});
