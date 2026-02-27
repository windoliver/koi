/**
 * Unit tests for normalizeInteraction() — Discord Interaction → InboundMessage.
 */

import { describe, expect, test } from "bun:test";
import type { Interaction } from "discord.js";
import { normalizeInteraction } from "./normalize-interaction.js";
import { createMockInteraction } from "./test-helpers.js";

/** Casts mock to Interaction for the normalizer. */
function asInteraction(mock: ReturnType<typeof createMockInteraction>): Interaction {
  return mock as unknown as Interaction;
}

describe("normalizeInteraction — slash commands", () => {
  test("returns text block with command name", async () => {
    const interaction = createMockInteraction({
      type: "command",
      commandName: "help",
      options: [],
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({ kind: "text", text: "/help" });
  });

  test("sets metadata with command details", async () => {
    const interaction = createMockInteraction({
      type: "command",
      commandName: "search",
      options: [{ name: "query", value: "hello", type: 3 }],
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result?.metadata).toMatchObject({
      isSlashCommand: true,
      commandName: "search",
      options: { query: "hello" },
    });
  });

  test("calls deferReply to acknowledge", async () => {
    const interaction = createMockInteraction({
      type: "command",
      commandName: "test",
      options: [],
    });
    await normalizeInteraction(asInteraction(interaction));
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  });

  test("still returns InboundMessage when deferReply fails", async () => {
    const interaction = createMockInteraction({
      type: "command",
      commandName: "test",
      options: [],
    });
    interaction.deferReply.mockImplementationOnce(() =>
      Promise.reject(new Error("Discord API error")),
    );
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({ kind: "text", text: "/test" });
  });

  test("sets senderId from user.id", async () => {
    const interaction = createMockInteraction({
      type: "command",
      userId: "cmd-user-42",
      commandName: "ping",
      options: [],
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result?.senderId).toBe("cmd-user-42");
  });

  test("sets threadId as guildId:channelId", async () => {
    const interaction = createMockInteraction({
      type: "command",
      guildId: "g1",
      channelId: "c1",
      commandName: "ping",
      options: [],
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result?.threadId).toBe("g1:c1");
  });
});

describe("normalizeInteraction — button clicks", () => {
  test("returns ButtonBlock with customId", async () => {
    const interaction = createMockInteraction({
      type: "button",
      customId: "confirm_action",
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result?.content[0]).toMatchObject({
      kind: "button",
      label: "confirm_action",
      action: "confirm_action",
    });
  });

  test("calls deferUpdate to acknowledge", async () => {
    const interaction = createMockInteraction({
      type: "button",
      customId: "btn",
    });
    await normalizeInteraction(asInteraction(interaction));
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeInteraction — select menus", () => {
  test("returns CustomBlock with selected values", async () => {
    const interaction = createMockInteraction({
      type: "select",
      customId: "color_picker",
      values: ["red", "blue"],
    });
    const result = await normalizeInteraction(asInteraction(interaction));
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:select_menu",
      data: { customId: "color_picker", values: ["red", "blue"] },
    });
  });
});

describe("normalizeInteraction — DM interactions", () => {
  test("sets threadId as dm:userId when guildId is null", async () => {
    const interaction = createMockInteraction({
      type: "command",
      guildId: null,
      userId: "dm-user-1",
      commandName: "help",
      options: [],
    });
    // Override channelId to null for DM — discord.js types allow string | null
    const raw = { ...interaction, channelId: null, guildId: null } as unknown as Interaction;
    const result = await normalizeInteraction(raw);
    expect(result?.threadId).toBe("dm:dm-user-1");
  });
});
