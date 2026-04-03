/**
 * Error path tests for createVoiceChannel().
 *
 * Tests failure modes: pipeline speak errors, session creation
 * before connect, and room manager failures.
 */

import { describe, expect, mock, test } from "bun:test";
import type { VoiceChannelConfig } from "./config.js";
import type { VoicePipeline } from "./pipeline.js";
import type { RoomService, TokenGenerator } from "./room.js";
import { createVoiceChannel } from "./voice-channel.js";

function createMockPipeline(overrides?: { readonly speakError?: Error }): VoicePipeline {
  return {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    speak: mock(async () => {
      if (overrides?.speakError !== undefined) {
        throw overrides.speakError;
      }
    }),
    isRunning: () => true,
    onTranscript: () => () => {},
    interrupt: mock(() => {}),
    isSpeaking: () => false,
  };
}

function createMockRoomService(): RoomService {
  return {
    createRoom: mock(async () => ({})),
    deleteRoom: mock(async () => {}),
  };
}

function createMockTokenGenerator(): TokenGenerator {
  return {
    generateToken: mock(async () => "mock-jwt-token"),
  };
}

const BASE_CONFIG: VoiceChannelConfig = {
  livekitUrl: "wss://test.livekit.io",
  livekitApiKey: "test-key",
  livekitApiSecret: "test-secret",
  stt: { provider: "deepgram", apiKey: "stt-key" },
  tts: { provider: "openai", apiKey: "tts-key" },
};

describe("createVoiceChannel — error paths", () => {
  test("createSession throws when not connected", async () => {
    const adapter = createVoiceChannel(BASE_CONFIG, {
      pipeline: createMockPipeline(),
      roomService: createMockRoomService(),
      tokenGenerator: createMockTokenGenerator(),
    });

    await expect(adapter.createSession()).rejects.toThrow("Voice channel not connected");
  });

  test("speak failure propagates through send", async () => {
    const speakError = new Error("TTS service unavailable");
    const adapter = createVoiceChannel(BASE_CONFIG, {
      pipeline: createMockPipeline({ speakError }),
      roomService: createMockRoomService(),
      tokenGenerator: createMockTokenGenerator(),
    });

    await adapter.connect();
    const session = await adapter.createSession();

    // send() wraps pipeline.speak with withRetry — after retries exhausted, error propagates
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "hello" }],
        threadId: session.roomName,
      }),
    ).rejects.toThrow("TTS service unavailable");

    await adapter.disconnect();
  });

  test("disconnect is safe to call multiple times", async () => {
    const adapter = createVoiceChannel(BASE_CONFIG, {
      pipeline: createMockPipeline(),
      roomService: createMockRoomService(),
      tokenGenerator: createMockTokenGenerator(),
    });

    await adapter.connect();
    await adapter.disconnect();
    // Second disconnect should not throw
    await adapter.disconnect();
  });
});
