/**
 * Unit tests for personasFromManifest.
 */

import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { personasFromManifest } from "./manifest.js";

const BASE_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "1.0.0",
  model: { name: "anthropic:claude-haiku-4-5-20251001" },
};

describe("personasFromManifest", () => {
  it("returns empty personas when manifest has no channels", () => {
    const result = personasFromManifest(BASE_MANIFEST);
    expect(result.personas).toHaveLength(0);
  });

  it("returns empty personas when channels have no identity", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [{ name: "@koi/channel-cli" }],
    };
    const result = personasFromManifest(manifest);
    expect(result.personas).toHaveLength(0);
  });

  it("extracts persona from channel with full identity", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [
        {
          name: "@koi/channel-telegram",
          identity: { name: "Alex", avatar: "casual.png", instructions: "Be casual." },
        },
      ],
    };
    const result = personasFromManifest(manifest);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toEqual({
      channelId: "@koi/channel-telegram",
      name: "Alex",
      avatar: "casual.png",
      instructions: "Be casual.",
    });
  });

  it("skips channels without identity, extracts those with it", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [
        { name: "@koi/channel-cli" },
        { name: "@koi/channel-telegram", identity: { name: "Alex" } },
        { name: "@koi/channel-slack", identity: { instructions: "Be formal." } },
      ],
    };
    const result = personasFromManifest(manifest);
    expect(result.personas).toHaveLength(2);
    expect(result.personas[0]?.channelId).toBe("@koi/channel-telegram");
    expect(result.personas[1]?.channelId).toBe("@koi/channel-slack");
  });

  it("sets channelId to channel.name", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [{ name: "@koi/channel-slack", identity: { name: "Bot" } }],
    };
    const result = personasFromManifest(manifest);
    expect(result.personas[0]?.channelId).toBe("@koi/channel-slack");
  });

  it("omits undefined identity fields from persona", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [{ name: "@koi/channel-telegram", identity: { name: "Alex" } }],
    };
    const result = personasFromManifest(manifest);
    const persona = result.personas[0];
    expect(persona?.name).toBe("Alex");
    expect("avatar" in (persona ?? {})).toBe(false);
    expect("instructions" in (persona ?? {})).toBe(false);
  });

  it("passes basePath through when provided", () => {
    const manifest: AgentManifest = {
      ...BASE_MANIFEST,
      channels: [{ name: "@koi/channel-telegram", identity: { name: "Alex" } }],
    };
    const result = personasFromManifest(manifest, { basePath: "/some/dir" });
    expect(result.basePath).toBe("/some/dir");
  });

  it("omits basePath when not provided", () => {
    const result = personasFromManifest(BASE_MANIFEST);
    expect("basePath" in result).toBe(false);
  });
});
