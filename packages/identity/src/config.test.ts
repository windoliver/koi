/**
 * Unit tests for validateIdentityConfig.
 */

import { describe, expect, it } from "bun:test";
import { validateIdentityConfig } from "./config.js";

describe("validateIdentityConfig", () => {
  it("returns ok for minimal valid config with empty personas", () => {
    const result = validateIdentityConfig({ personas: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.personas).toHaveLength(0);
    }
  });

  it("returns ok for config with a valid persona entry", () => {
    const result = validateIdentityConfig({
      personas: [
        {
          channelId: "@koi/channel-telegram",
          name: "Alex",
          instructions: "Be casual.",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok for persona with instruction path object", () => {
    const result = validateIdentityConfig({
      personas: [
        {
          channelId: "@koi/channel-slack",
          instructions: { path: "./persona.md" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok with basePath provided", () => {
    const result = validateIdentityConfig({
      personas: [{ channelId: "@koi/channel-cli" }],
      basePath: "/some/path",
    });
    expect(result.ok).toBe(true);
  });

  it("returns error when config is not an object", () => {
    const result = validateIdentityConfig("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("returns error when personas is missing", () => {
    const result = validateIdentityConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("personas");
    }
  });

  it("returns error when personas is not an array", () => {
    const result = validateIdentityConfig({ personas: "not an array" });
    expect(result.ok).toBe(false);
  });

  it("returns error when persona entry is not an object", () => {
    const result = validateIdentityConfig({ personas: ["bad"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("personas[0]");
    }
  });

  it("returns error when channelId is missing", () => {
    const result = validateIdentityConfig({ personas: [{ name: "Alex" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("channelId");
    }
  });

  it("returns error when channelId is empty string", () => {
    const result = validateIdentityConfig({ personas: [{ channelId: "" }] });
    expect(result.ok).toBe(false);
  });

  it("returns error when instructions is neither string nor path object", () => {
    const result = validateIdentityConfig({
      personas: [{ channelId: "@koi/channel-telegram", instructions: 42 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("instructions");
    }
  });

  it("returns error when instructions.path is not a string", () => {
    const result = validateIdentityConfig({
      personas: [{ channelId: "@koi/channel-telegram", instructions: { path: 42 } }],
    });
    expect(result.ok).toBe(false);
  });

  it("returns error when basePath is not a string", () => {
    const result = validateIdentityConfig({
      personas: [],
      basePath: 123,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("basePath");
    }
  });

  it("returns error when persona name is not a string", () => {
    const result = validateIdentityConfig({
      personas: [{ channelId: "@koi/channel-telegram", name: 42 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("name");
    }
  });

  it("returns error when persona avatar is not a string", () => {
    const result = validateIdentityConfig({
      personas: [{ channelId: "@koi/channel-telegram", avatar: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("avatar");
    }
  });
});
