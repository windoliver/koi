import { describe, expect, test } from "bun:test";
import { validateChatSdkChannelConfig } from "./config.js";

describe("validateChatSdkChannelConfig", () => {
  test("accepts config with one platform", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [{ platform: "slack" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platforms).toHaveLength(1);
      expect(result.value.platforms[0]?.platform).toBe("slack");
    }
  });

  test("accepts config with all 6 platforms", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [
        { platform: "slack" },
        { platform: "discord" },
        { platform: "teams" },
        { platform: "gchat" },
        { platform: "github" },
        { platform: "linear" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platforms).toHaveLength(6);
    }
  });

  test("accepts config with explicit credentials", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [{ platform: "slack", botToken: "xoxb-123", signingSecret: "secret" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const slack = result.value.platforms[0];
      expect(slack?.platform).toBe("slack");
      if (slack?.platform === "slack") {
        expect(slack.botToken).toBe("xoxb-123");
        expect(slack.signingSecret).toBe("secret");
      }
    }
  });

  test("accepts config with userName", () => {
    const result = validateChatSdkChannelConfig({
      userName: "mybot",
      platforms: [{ platform: "slack" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userName).toBe("mybot");
    }
  });

  test("rejects empty platforms array", () => {
    const result = validateChatSdkChannelConfig({ platforms: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("at least one platform");
    }
  });

  test("rejects missing platforms field", () => {
    const result = validateChatSdkChannelConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects non-object input", () => {
    const result = validateChatSdkChannelConfig("not-an-object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects unknown platform name", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [{ platform: "whatsapp" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("whatsapp");
    }
  });

  test("rejects duplicate platforms", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [{ platform: "slack" }, { platform: "slack" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Duplicate");
    }
  });

  test("rejects platform entry without platform field", () => {
    const result = validateChatSdkChannelConfig({
      platforms: [{}],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});
