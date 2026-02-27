/**
 * Unit tests for normalizeReaction() — Discord Reaction → InboundMessage.
 */

import { describe, expect, test } from "bun:test";
import type { MessageReaction, User } from "discord.js";
import { normalizeReaction } from "./normalize-reaction.js";
import { createMockReaction } from "./test-helpers.js";

const BOT_USER_ID = "bot-123";

function asReaction(mock: ReturnType<typeof createMockReaction>): {
  readonly reaction: MessageReaction;
  readonly user: User;
} {
  return {
    reaction: mock.reaction as unknown as MessageReaction,
    user: mock.user as unknown as User,
  };
}

describe("normalizeReaction — add", () => {
  test("returns custom block with emoji data", () => {
    const mocks = createMockReaction({ emojiName: "👍" });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: {
        action: "add",
        messageId: "msg-001",
        emoji: { id: null, name: "👍", animated: false },
      },
    });
  });

  test("sets senderId from user.id", () => {
    const mocks = createMockReaction({ userId: "reactor-42" });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result?.senderId).toBe("reactor-42");
  });

  test("sets threadId as guildId:channelId", () => {
    const mocks = createMockReaction({ guildId: "g1", channelId: "c1" });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result?.threadId).toBe("g1:c1");
  });

  test("sets threadId as dm:userId when guildId is null", () => {
    const mocks = createMockReaction({ guildId: null, userId: "dm-user" });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result?.threadId).toBe("dm:dm-user");
  });

  test("handles custom emoji with id", () => {
    const mocks = createMockReaction({
      emojiId: "emoji-123",
      emojiName: "custom_emote",
      emojiAnimated: true,
    });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: {
        emoji: { id: "emoji-123", name: "custom_emote", animated: true },
      },
    });
  });
});

describe("normalizeReaction — remove", () => {
  test("returns action 'remove'", () => {
    const mocks = createMockReaction({ emojiName: "❌" });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "remove", BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: { action: "remove" },
    });
  });
});

describe("normalizeReaction — bot filtering", () => {
  test("returns null for bot's own reactions", () => {
    const mocks = createMockReaction({ userId: BOT_USER_ID });
    const { reaction, user } = asReaction(mocks);
    const result = normalizeReaction(reaction, user, "add", BOT_USER_ID);
    expect(result).toBeNull();
  });
});
