import { describe, expect, test } from "bun:test";
import { capabilitiesForPlatform } from "./capabilities.js";
import type { PlatformName } from "./config.js";

const ALL_PLATFORMS: readonly PlatformName[] = [
  "slack",
  "discord",
  "teams",
  "gchat",
  "github",
  "linear",
];

describe("capabilitiesForPlatform", () => {
  test("returns capabilities for all platforms", () => {
    for (const platform of ALL_PLATFORMS) {
      const caps = capabilitiesForPlatform(platform);
      expect(caps).toBeDefined();
      expect(caps.text).toBe(true);
      expect(caps.threads).toBe(true);
    }
  });

  test("slack supports images, files, and buttons", () => {
    const caps = capabilitiesForPlatform("slack");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(true);
    expect(caps.buttons).toBe(true);
    expect(caps.audio).toBe(false);
    expect(caps.video).toBe(false);
  });

  test("discord supports images, files, and buttons", () => {
    const caps = capabilitiesForPlatform("discord");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(true);
    expect(caps.buttons).toBe(true);
  });

  test("teams supports images, files, and buttons", () => {
    const caps = capabilitiesForPlatform("teams");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(true);
    expect(caps.buttons).toBe(true);
  });

  test("gchat supports images and buttons but not files", () => {
    const caps = capabilitiesForPlatform("gchat");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(false);
    expect(caps.buttons).toBe(true);
  });

  test("github supports images but not files or buttons", () => {
    const caps = capabilitiesForPlatform("github");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(false);
    expect(caps.buttons).toBe(false);
  });

  test("linear supports images but not files or buttons", () => {
    const caps = capabilitiesForPlatform("linear");
    expect(caps.images).toBe(true);
    expect(caps.files).toBe(false);
    expect(caps.buttons).toBe(false);
  });

  test("no platform supports audio or video", () => {
    for (const platform of ALL_PLATFORMS) {
      const caps = capabilitiesForPlatform(platform);
      expect(caps.audio).toBe(false);
      expect(caps.video).toBe(false);
    }
  });
});
