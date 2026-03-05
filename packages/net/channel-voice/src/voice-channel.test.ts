/**
 * Unit tests for createVoiceChannel().
 */

import { describe, expect, test } from "bun:test";
import type { VoiceChannelConfig } from "./config.js";
import {
  createMockRoomService,
  createMockTokenGenerator,
  createMockTranscript,
  createMockVoicePipeline,
} from "./test-helpers.js";
import { createVoiceChannel } from "./voice-channel.js";

const BASE_CONFIG: VoiceChannelConfig = {
  livekitUrl: "wss://livekit.example.com",
  livekitApiKey: "api-key",
  livekitApiSecret: "api-secret",
  stt: { provider: "deepgram", apiKey: "dg-key" },
  tts: { provider: "openai", apiKey: "oai-key" },
  maxConcurrentSessions: 3,
};

function makeAdapter(configOverrides?: Partial<VoiceChannelConfig>) {
  const pipeline = createMockVoicePipeline();
  const roomService = createMockRoomService();
  const tokenGen = createMockTokenGenerator();
  const config: VoiceChannelConfig = { ...BASE_CONFIG, ...configOverrides };
  const adapter = createVoiceChannel(config, {
    pipeline,
    roomService,
    tokenGenerator: tokenGen,
  });
  return { adapter, pipeline, roomService, tokenGen };
}

// ---------------------------------------------------------------------------
// Factory and capabilities
// ---------------------------------------------------------------------------

describe("createVoiceChannel — capabilities", () => {
  test("has name 'voice'", () => {
    const { adapter } = makeAdapter();
    expect(adapter.name).toBe("voice");
  });

  test("declares correct capabilities", () => {
    const { adapter } = makeAdapter();
    expect(adapter.capabilities).toEqual({
      text: true,
      audio: true,
      images: false,
      files: false,
      buttons: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    });
  });

  test("activeRoom is undefined before createSession()", () => {
    const { adapter } = makeAdapter();
    expect(adapter.activeRoom).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("createVoiceChannel — lifecycle", () => {
  test("connect() is idempotent", async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    await adapter.connect();
    await adapter.disconnect();
  });

  test("disconnect() stops pipeline and cleanup sweep", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();
    expect(pipeline.isRunning()).toBe(true);

    await adapter.disconnect();
    expect(pipeline.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe("createVoiceChannel — sessions", () => {
  test("createSession() returns room info", async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();

    const session = await adapter.createSession();
    expect(session.roomName).toMatch(/^voice-/);
    expect(session.token).toMatch(/^mock-jwt-/);
    expect(session.wsUrl).toBe("wss://livekit.example.com");

    await adapter.disconnect();
  });

  test("createSession() starts pipeline", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();

    expect(pipeline.isRunning()).toBe(false);
    await adapter.createSession();
    expect(pipeline.isRunning()).toBe(true);

    await adapter.disconnect();
  });

  test("createSession() updates activeRoom", async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();

    const session = await adapter.createSession();
    expect(adapter.activeRoom).toBe(session.roomName);

    await adapter.disconnect();
  });

  test("createSession() at max capacity throws", async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();

    await adapter.createSession();
    await adapter.createSession();
    await adapter.createSession();

    await expect(adapter.createSession()).rejects.toThrow(/Maximum concurrent sessions/);

    await adapter.disconnect();
  });

  test("createSession() before connect() throws", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.createSession()).rejects.toThrow(/not connected/);
  });
});

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

describe("createVoiceChannel — send", () => {
  test("send() with TextBlock calls pipeline.speak()", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.send({
      content: [{ kind: "text", text: "Hello voice" }],
    });

    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Hello voice");

    await adapter.disconnect();
  });

  test("send() with multiple TextBlocks speaks each as a chunk", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.send({
      content: [
        { kind: "text", text: "Line one" },
        { kind: "text", text: "Line two" },
      ],
    });

    // Chunker merges short lines (< minChunkWords) into a single chunk
    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Line one Line two");

    await adapter.disconnect();
  });

  test("send() with multi-sentence text calls speak() per chunk", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.send({
      content: [
        {
          kind: "text",
          text: "First sentence here. Second sentence follows. Third sentence ends it.",
        },
      ],
    });

    // With default chunking (minChunkWords=3, maxChunkChars=200), each sentence
    // has >= 3 words and fits within 200 chars, so expect 3 speak() calls
    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(3);
    expect(pipeline.mocks.speak).toHaveBeenNthCalledWith(1, "First sentence here.");
    expect(pipeline.mocks.speak).toHaveBeenNthCalledWith(2, "Second sentence follows.");
    expect(pipeline.mocks.speak).toHaveBeenNthCalledWith(3, "Third sentence ends it.");

    await adapter.disconnect();
  });

  test("send() with ttsChunking: false calls speak() once with full text", async () => {
    const pipeline = createMockVoicePipeline();
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const config: VoiceChannelConfig = { ...BASE_CONFIG, ttsChunking: false };
    const adapter = createVoiceChannel(config, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();

    await adapter.send({
      content: [
        {
          kind: "text",
          text: "First sentence here. Second sentence follows. Third sentence ends it.",
        },
      ],
    });

    // Chunking disabled — single speak() with full text
    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith(
      "First sentence here. Second sentence follows. Third sentence ends it.",
    );

    await adapter.disconnect();
  });

  test("send() with non-text block skips gracefully", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    // Image block — voice doesn't support it, should be downgraded to text by renderBlocks
    // Since images capability is false, renderBlocks converts it to TextBlock fallback
    await adapter.send({
      content: [{ kind: "image", url: "https://example.com/img.png", alt: "test" }],
    });

    // renderBlocks converts to text "[Image: test]", so speak should be called
    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// sendStatus
// ---------------------------------------------------------------------------

describe("createVoiceChannel — sendStatus", () => {
  test("sendStatus is defined on the adapter", () => {
    const { adapter } = makeAdapter();
    expect(adapter.sendStatus).toBeDefined();
  });

  test("sendStatus({ kind: 'processing' }) speaks filler via pipeline", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });

    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("one moment");

    await adapter.disconnect();
  });

  test("sendStatus({ kind: 'processing', detail }) uses custom detail", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0, detail: "searching" });

    expect(pipeline.mocks.speak).toHaveBeenCalledWith("searching");

    await adapter.disconnect();
  });

  test("sendStatus({ kind: 'idle' }) is a no-op", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.sendStatus?.({ kind: "idle", turnIndex: 0 });

    expect(pipeline.mocks.speak).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  test("sendStatus({ kind: 'error' }) is a no-op", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    await adapter.sendStatus?.({ kind: "error", turnIndex: 0 });

    expect(pipeline.mocks.speak).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  test("sendStatus({ kind: 'processing' }) when pipeline not running is a no-op", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    // No createSession — pipeline not started

    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });

    expect(pipeline.mocks.speak).not.toHaveBeenCalled();

    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Retry on speak
// ---------------------------------------------------------------------------

describe("createVoiceChannel — retry", () => {
  test("send() retries on transient speak failure", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    // First call fails, second succeeds
    // let requires justification: mutable call counter for mock
    let callCount = 0;
    pipeline.mocks.speak.mockImplementation(async (_text: string): Promise<void> => {
      callCount++;
      if (callCount === 1) {
        const error = new Error("TTS transient failure");
        // @ts-expect-error — attaching retryable for withRetry() to detect
        error.retryable = true;
        throw error;
      }
    });

    await adapter.send({
      content: [{ kind: "text", text: "Retry me" }],
    });

    expect(callCount).toBe(2);

    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Receiving messages (inbound)
// ---------------------------------------------------------------------------

describe("createVoiceChannel — onMessage", () => {
  test("onMessage() handler receives InboundMessage from transcript", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    pipeline.emitTranscript(createMockTranscript("Hello from user"));

    // Allow async dispatch to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    const msg = received[0] as { content: readonly { kind: string; text: string }[] };
    expect(msg.content[0]?.text).toBe("Hello from user");

    await adapter.disconnect();
  });

  test("empty transcript does not trigger handler", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    pipeline.emitTranscript({
      text: "",
      isFinal: true,
      participantId: "user-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  test("non-final transcript does not trigger handler", async () => {
    const { adapter, pipeline } = makeAdapter();
    await adapter.connect();
    await adapter.createSession();

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    pipeline.emitTranscript({
      text: "partial...",
      isFinal: false,
      participantId: "user-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  test("error in handler is isolated (other handlers still fire)", async () => {
    const errors: unknown[] = [];
    const { adapter, pipeline } = makeAdapter({
      onHandlerError: (err) => errors.push(err),
    });
    await adapter.connect();
    await adapter.createSession();

    const received: unknown[] = [];
    adapter.onMessage(async () => {
      throw new Error("handler boom");
    });
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    pipeline.emitTranscript(createMockTranscript("Test"));

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second handler should still receive the message
    expect(received).toHaveLength(1);
    // Error should be reported
    expect(errors).toHaveLength(1);

    await adapter.disconnect();
  });
});
