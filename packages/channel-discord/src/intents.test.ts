/**
 * Unit tests for computeIntents() — feature flags → GatewayIntentBits.
 */

import { describe, expect, test } from "bun:test";
import { GatewayIntentBits } from "discord.js";
import { computeIntents } from "./intents.js";

describe("computeIntents", () => {
  test("includes Guilds intent by default", () => {
    const intents = computeIntents();
    expect(intents).toContain(GatewayIntentBits.Guilds);
  });

  test("includes GuildMessages and MessageContent when text is true (default)", () => {
    const intents = computeIntents();
    expect(intents).toContain(GatewayIntentBits.GuildMessages);
    expect(intents).toContain(GatewayIntentBits.MessageContent);
  });

  test("excludes GuildMessages and MessageContent when text is false", () => {
    const intents = computeIntents({ text: false });
    expect(intents).not.toContain(GatewayIntentBits.GuildMessages);
    expect(intents).not.toContain(GatewayIntentBits.MessageContent);
  });

  test("includes GuildVoiceStates when voice is true", () => {
    const intents = computeIntents({ voice: true });
    expect(intents).toContain(GatewayIntentBits.GuildVoiceStates);
  });

  test("excludes GuildVoiceStates when voice is false (default)", () => {
    const intents = computeIntents();
    expect(intents).not.toContain(GatewayIntentBits.GuildVoiceStates);
  });

  test("includes GuildMessageReactions when reactions is true", () => {
    const intents = computeIntents({ reactions: true });
    expect(intents).toContain(GatewayIntentBits.GuildMessageReactions);
  });

  test("excludes GuildMessageReactions when reactions is false (default)", () => {
    const intents = computeIntents();
    expect(intents).not.toContain(GatewayIntentBits.GuildMessageReactions);
  });

  test("does not add extra intents for threads (uses Guilds)", () => {
    const withThreads = computeIntents({ threads: true });
    const withoutThreads = computeIntents({ threads: false });
    // Both should contain Guilds; threads doesn't add new intents
    expect(withThreads).toContain(GatewayIntentBits.Guilds);
    expect(withoutThreads).toContain(GatewayIntentBits.Guilds);
  });

  test("does not add extra intents for slashCommands", () => {
    const withSlash = computeIntents({ slashCommands: true });
    const withoutSlash = computeIntents({ slashCommands: false });
    // Same set — slash commands use interaction events, not intents
    expect(withSlash.length).toBe(withoutSlash.length);
  });

  test("all features enabled produces correct set", () => {
    const intents = computeIntents({
      text: true,
      voice: true,
      reactions: true,
      threads: true,
      slashCommands: true,
    });
    expect(intents).toContain(GatewayIntentBits.Guilds);
    expect(intents).toContain(GatewayIntentBits.GuildMessages);
    expect(intents).toContain(GatewayIntentBits.MessageContent);
    expect(intents).toContain(GatewayIntentBits.GuildVoiceStates);
    expect(intents).toContain(GatewayIntentBits.GuildMessageReactions);
    expect(intents).toHaveLength(5);
  });

  test("all features disabled only includes Guilds", () => {
    const intents = computeIntents({
      text: false,
      voice: false,
      reactions: false,
      threads: false,
      slashCommands: false,
    });
    expect(intents).toEqual([GatewayIntentBits.Guilds]);
  });

  test("returns deduplicated intents", () => {
    const intents = computeIntents({ text: true });
    const unique = [...new Set(intents)];
    expect(intents).toEqual(unique);
  });
});
