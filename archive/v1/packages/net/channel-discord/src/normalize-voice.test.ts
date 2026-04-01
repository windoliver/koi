/**
 * Unit tests for normalizeVoiceState() — Discord VoiceState → InboundMessage.
 */

import { describe, expect, test } from "bun:test";
import type { VoiceState } from "discord.js";
import { normalizeVoiceState } from "./normalize-voice.js";
import { createMockVoiceState } from "./test-helpers.js";

const BOT_USER_ID = "bot-123";

/** Casts mock to VoiceState for the normalizer. */
function asVoiceState(mock: ReturnType<typeof createMockVoiceState>): VoiceState {
  return mock as unknown as VoiceState;
}

describe("normalizeVoiceState — join events", () => {
  test("detects join when old channelId is null", () => {
    const oldState = createMockVoiceState({ channelId: null });
    const newState = createMockVoiceState({ channelId: "vc-1" });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "join" }),
    });
  });
});

describe("normalizeVoiceState — leave events", () => {
  test("detects leave when new channelId is null", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1" });
    const newState = createMockVoiceState({ channelId: null });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "leave" }),
    });
  });
});

describe("normalizeVoiceState — move events", () => {
  test("detects move when channels differ", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1" });
    const newState = createMockVoiceState({ channelId: "vc-2" });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "move" }),
    });
  });
});

describe("normalizeVoiceState — mute/deafen events", () => {
  test("detects mute change", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1", selfMute: false });
    const newState = createMockVoiceState({ channelId: "vc-1", selfMute: true });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "mute" }),
    });
  });

  test("detects deafen change", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1", selfDeaf: false });
    const newState = createMockVoiceState({ channelId: "vc-1", selfDeaf: true });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "deafen" }),
    });
  });

  test("detects server mute change", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1", serverMute: false });
    const newState = createMockVoiceState({ channelId: "vc-1", serverMute: true });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:voice_state",
      data: expect.objectContaining({ action: "mute" }),
    });
  });
});

describe("normalizeVoiceState — bot filtering", () => {
  test("returns null for bot's own voice state changes", () => {
    const oldState = createMockVoiceState({
      channelId: null,
      memberId: BOT_USER_ID,
      memberBot: true,
    });
    const newState = createMockVoiceState({
      channelId: "vc-1",
      memberId: BOT_USER_ID,
      memberBot: true,
    });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result).toBeNull();
  });
});

describe("normalizeVoiceState — threadId", () => {
  test("sets threadId as guildId:channelId", () => {
    const oldState = createMockVoiceState({ channelId: null, guildId: "g1" });
    const newState = createMockVoiceState({ channelId: "vc-1", guildId: "g1" });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.threadId).toBe("g1:vc-1");
  });

  test("uses old channelId for leave events", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1", guildId: "g1" });
    const newState = createMockVoiceState({ channelId: null, guildId: "g1" });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    expect(result?.threadId).toBe("g1:vc-1");
  });
});

describe("normalizeVoiceState — metadata", () => {
  test("includes old and new channel IDs in data", () => {
    const oldState = createMockVoiceState({ channelId: "vc-1" });
    const newState = createMockVoiceState({ channelId: "vc-2" });
    const result = normalizeVoiceState(asVoiceState(oldState), asVoiceState(newState), BOT_USER_ID);
    const data = (result?.content[0] as { readonly data: Record<string, unknown> }).data;
    expect(data.oldChannelId).toBe("vc-1");
    expect(data.channelId).toBe("vc-2");
  });
});
