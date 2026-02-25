/**
 * Unit tests for buildPersonaMap and resolvePersonaContent.
 */

import { describe, expect, it } from "bun:test";
import { buildPersonaMap, buildWatchedPaths, resolvePersonaContent } from "./persona-map.js";

describe("resolvePersonaContent", () => {
  it("returns inline instructions with no sources tracked", () => {
    const result = resolvePersonaContent(
      { channelId: "@koi/channel-telegram", instructions: "Be casual." },
      undefined,
    );
    expect(result.channelId).toBe("@koi/channel-telegram");
    expect(result.instructions).toBe("Be casual.");
    expect(result.sources).toHaveLength(0);
  });

  it("returns empty instructions when not provided", () => {
    const result = resolvePersonaContent({ channelId: "@koi/channel-cli" }, undefined);
    expect(result.instructions).toBe("");
    expect(result.sources).toHaveLength(0);
  });

  it("includes name and avatar when provided", () => {
    const result = resolvePersonaContent(
      { channelId: "@koi/channel-slack", name: "Alex", avatar: "casual.png" },
      undefined,
    );
    expect(result.name).toBe("Alex");
    expect(result.avatar).toBe("casual.png");
  });

  it("omits name and avatar when not provided", () => {
    const result = resolvePersonaContent({ channelId: "@koi/channel-cli" }, undefined);
    expect("name" in result).toBe(false);
    expect("avatar" in result).toBe(false);
  });
});

describe("buildPersonaMap", () => {
  it("creates map entries for personas with injectable content", async () => {
    const map = await buildPersonaMap({
      personas: [
        { channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." },
        { channelId: "@koi/channel-slack", instructions: "Be formal." },
      ],
    });
    expect(map.size).toBe(2);
    expect(map.has("@koi/channel-telegram")).toBe(true);
    expect(map.has("@koi/channel-slack")).toBe(true);
  });

  it("excludes personas with no name and no instructions", async () => {
    const map = await buildPersonaMap({
      personas: [
        { channelId: "@koi/channel-cli" }, // no name, no instructions
        { channelId: "@koi/channel-telegram", name: "Alex" },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.has("@koi/channel-cli")).toBe(false);
    expect(map.has("@koi/channel-telegram")).toBe(true);
  });

  it("pre-builds system message with name prefix", async () => {
    const map = await buildPersonaMap({
      personas: [{ channelId: "@koi/channel-telegram", name: "Alex", instructions: "Be casual." }],
    });
    const cached = map.get("@koi/channel-telegram");
    expect(cached).toBeDefined();
    if (cached !== undefined) {
      const block = cached.message.content[0];
      expect(block?.kind).toBe("text");
      if (block?.kind === "text") {
        expect(block.text).toContain("You are Alex.");
        expect(block.text).toContain("Be casual.");
      }
    }
  });

  it("pre-builds system message with instructions only", async () => {
    const map = await buildPersonaMap({
      personas: [{ channelId: "@koi/channel-slack", instructions: "Be formal and concise." }],
    });
    const cached = map.get("@koi/channel-slack");
    expect(cached?.message.content[0]?.kind).toBe("text");
    if (cached?.message.content[0]?.kind === "text") {
      expect(cached.message.content[0].text).toBe("Be formal and concise.");
    }
  });

  it("returns empty map for empty personas array", async () => {
    const map = await buildPersonaMap({ personas: [] });
    expect(map.size).toBe(0);
  });

  it("sets senderId to system:identity", async () => {
    const map = await buildPersonaMap({
      personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
    });
    const cached = map.get("@koi/channel-telegram");
    expect(cached?.message.senderId).toBe("system:identity");
  });
});

describe("buildWatchedPaths", () => {
  it("collects file paths from cached persona sources", async () => {
    const map = await buildPersonaMap({
      personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }],
    });
    // No file sources for inline instructions
    const paths = buildWatchedPaths(map);
    expect(paths.size).toBe(0);
  });

  it("returns empty set for empty map", () => {
    const paths = buildWatchedPaths(new Map());
    expect(paths.size).toBe(0);
  });
});
