/**
 * Unit tests for the normalize composer.
 */

import { describe, expect, test } from "bun:test";
import type { Interaction, Message, MessageReaction, User, VoiceState } from "discord.js";
import type { DiscordEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";
import {
  createMockInteraction,
  createMockMessage,
  createMockReaction,
  createMockVoiceState,
} from "./test-helpers.js";

const BOT_USER_ID = "bot-123";
const normalize = createNormalizer(BOT_USER_ID);

describe("normalize — composer dispatch", () => {
  test("dispatches message events to normalizeMessage", async () => {
    const msg = createMockMessage({ content: "hello" });
    const event: DiscordEvent = { kind: "message", message: msg as unknown as Message };
    const result = await normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({ kind: "text", text: "hello" });
  });

  test("dispatches interaction events to normalizeInteraction", async () => {
    const interaction = createMockInteraction({
      type: "command",
      commandName: "ping",
      options: [],
    });
    const event: DiscordEvent = {
      kind: "interaction",
      interaction: interaction as unknown as Interaction,
    };
    const result = await normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({ kind: "text", text: "/ping" });
  });

  test("dispatches voiceStateUpdate events to normalizeVoiceState", async () => {
    const oldState = createMockVoiceState({ channelId: null });
    const newState = createMockVoiceState({ channelId: "vc-1" });
    const event: DiscordEvent = {
      kind: "voiceStateUpdate",
      oldState: oldState as unknown as VoiceState,
      newState: newState as unknown as VoiceState,
    };
    const result = await normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
    });
  });

  test("dispatches reactionAdd events to normalizeReaction", async () => {
    const mocks = createMockReaction({ emojiName: "🎉" });
    const event: DiscordEvent = {
      kind: "reactionAdd",
      reaction: mocks.reaction as unknown as MessageReaction,
      user: mocks.user as unknown as User,
    };
    const result = await normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: { action: "add" },
    });
  });

  test("dispatches reactionRemove events to normalizeReaction", async () => {
    const mocks = createMockReaction({ emojiName: "❌" });
    const event: DiscordEvent = {
      kind: "reactionRemove",
      reaction: mocks.reaction as unknown as MessageReaction,
      user: mocks.user as unknown as User,
    };
    const result = await normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: { action: "remove" },
    });
  });

  test("returns null for bot's own messages", async () => {
    const msg = createMockMessage({ authorId: BOT_USER_ID, authorBot: true });
    const event: DiscordEvent = { kind: "message", message: msg as unknown as Message };
    const result = await normalize(event);
    expect(result).toBeNull();
  });
});
