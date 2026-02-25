/**
 * Config validation tests for @koi/channel-voice.
 */

import { describe, expect, test } from "bun:test";
import { validateVoiceConfig } from "./config.js";

const VALID_CONFIG = {
  livekitUrl: "wss://livekit.example.com",
  livekitApiKey: "api-key-123",
  livekitApiSecret: "api-secret-456",
  stt: { provider: "deepgram", apiKey: "dg-key" },
  tts: { provider: "openai", apiKey: "oai-key" },
} as const;

describe("validateVoiceConfig", () => {
  test("accepts valid config", () => {
    const result = validateVoiceConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.livekitUrl).toBe("wss://livekit.example.com");
    }
  });

  test("rejects null config", () => {
    const result = validateVoiceConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined config", () => {
    const result = validateVoiceConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateVoiceConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects missing livekitUrl", () => {
    const { livekitUrl: _, ...rest } = VALID_CONFIG;
    const result = validateVoiceConfig(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("livekitUrl");
    }
  });

  test("rejects empty livekitUrl", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, livekitUrl: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("livekitUrl");
    }
  });

  test("rejects missing livekitApiKey", () => {
    const { livekitApiKey: _, ...rest } = VALID_CONFIG;
    const result = validateVoiceConfig(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("livekitApiKey");
    }
  });

  test("rejects missing livekitApiSecret", () => {
    const { livekitApiSecret: _, ...rest } = VALID_CONFIG;
    const result = validateVoiceConfig(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("livekitApiSecret");
    }
  });

  test("rejects missing stt config", () => {
    const { stt: _, ...rest } = VALID_CONFIG;
    const result = validateVoiceConfig(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stt");
    }
  });

  test("rejects invalid stt provider", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      stt: { provider: "invalid", apiKey: "key" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stt.provider");
    }
  });

  test("rejects missing stt apiKey", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      stt: { provider: "deepgram" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stt.apiKey");
    }
  });

  test("rejects missing tts config", () => {
    const { tts: _, ...rest } = VALID_CONFIG;
    const result = validateVoiceConfig(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tts");
    }
  });

  test("rejects invalid tts provider", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      tts: { provider: "invalid", apiKey: "key" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tts.provider");
    }
  });

  test("rejects missing tts apiKey", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      tts: { provider: "openai" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tts.apiKey");
    }
  });

  test("rejects zero maxConcurrentSessions", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, maxConcurrentSessions: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxConcurrentSessions");
    }
  });

  test("rejects negative maxConcurrentSessions", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, maxConcurrentSessions: -5 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-number maxConcurrentSessions", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, maxConcurrentSessions: "ten" });
    expect(result.ok).toBe(false);
  });

  test("accepts valid maxConcurrentSessions", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, maxConcurrentSessions: 20 });
    expect(result.ok).toBe(true);
  });

  test("rejects zero roomEmptyTimeoutSeconds", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, roomEmptyTimeoutSeconds: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative roomEmptyTimeoutSeconds", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, roomEmptyTimeoutSeconds: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts valid roomEmptyTimeoutSeconds", () => {
    const result = validateVoiceConfig({ ...VALID_CONFIG, roomEmptyTimeoutSeconds: 600 });
    expect(result.ok).toBe(true);
  });

  test("accepts openai STT provider", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      stt: { provider: "openai", apiKey: "oai-key" },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts deepgram TTS provider", () => {
    const result = validateVoiceConfig({
      ...VALID_CONFIG,
      tts: { provider: "deepgram", apiKey: "dg-key" },
    });
    expect(result.ok).toBe(true);
  });

  test("optional fields absent uses defaults", () => {
    const result = validateVoiceConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxConcurrentSessions).toBeUndefined();
      expect(result.value.roomEmptyTimeoutSeconds).toBeUndefined();
      expect(result.value.debug).toBeUndefined();
    }
  });

  test("validation error has VALIDATION code and is not retryable", () => {
    const result = validateVoiceConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });
});
