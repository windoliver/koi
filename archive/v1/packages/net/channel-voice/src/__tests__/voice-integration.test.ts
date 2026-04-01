/**
 * Integration tests — full pipeline from config to InboundMessage.
 *
 * Uses mock pipeline + mock room service to verify the complete flow
 * without real LiveKit infrastructure.
 */

import { describe, expect, test } from "bun:test";
import { type VoiceChannelConfig, validateVoiceConfig } from "../config.js";
import {
  createMockRoomService,
  createMockTokenGenerator,
  createMockTranscript,
  createMockVoicePipeline,
} from "../test-helpers.js";
import { createVoiceChannel } from "../voice-channel.js";

const RAW_CONFIG = {
  livekitUrl: "wss://livekit.example.com",
  livekitApiKey: "api-key",
  livekitApiSecret: "api-secret",
  stt: { provider: "deepgram", apiKey: "dg-key" },
  tts: { provider: "openai", apiKey: "oai-key" },
  maxConcurrentSessions: 5,
} as const;

function makeIntegrationSetup() {
  const pipeline = createMockVoicePipeline();
  const roomService = createMockRoomService();
  const tokenGen = createMockTokenGenerator();
  return { pipeline, roomService, tokenGen };
}

describe("voice-integration", () => {
  test("config → validate → createVoiceChannel → connect → transcript → InboundMessage", async () => {
    const configResult = validateVoiceConfig(RAW_CONFIG);
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(configResult.value, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    const session = await adapter.createSession();
    expect(session.roomName).toMatch(/^voice-/);

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    pipeline.emitTranscript(createMockTranscript("Integration test"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    const msg = received[0] as {
      readonly content: readonly { readonly kind: string; readonly text: string }[];
      readonly senderId: string;
      readonly threadId: string;
    };
    expect(msg.content[0]?.kind).toBe("text");
    expect(msg.content[0]?.text).toBe("Integration test");
    expect(msg.senderId).toBe("user-1");

    await adapter.disconnect();
  });

  test("send response → pipeline.speak() called", async () => {
    const configResult = validateVoiceConfig(RAW_CONFIG);
    if (!configResult.ok) return;

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(configResult.value, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();

    await adapter.send({
      content: [{ kind: "text", text: "Agent response" }],
    });

    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Agent response");

    await adapter.disconnect();
  });

  test("session lifecycle: create → converse → disconnect", async () => {
    const configResult = validateVoiceConfig(RAW_CONFIG);
    if (!configResult.ok) return;

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(configResult.value, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();

    // Simulate conversation
    const messages: unknown[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });

    pipeline.emitTranscript(createMockTranscript("User says hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages).toHaveLength(1);

    await adapter.send({ content: [{ kind: "text", text: "Agent says hello back" }] });
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Agent says hello back");

    // Disconnect cleans up everything
    await adapter.disconnect();
    expect(pipeline.isRunning()).toBe(false);
    expect(adapter.activeRoom).toBeUndefined();
  });

  test("concurrent sessions: max capacity enforced", async () => {
    const configResult = validateVoiceConfig({ ...RAW_CONFIG, maxConcurrentSessions: 2 });
    if (!configResult.ok) return;

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(configResult.value, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();
    await adapter.createSession();

    await expect(adapter.createSession()).rejects.toThrow(/Maximum concurrent sessions/);

    await adapter.disconnect();
  });

  test("barge-in: speak interrupted by transcript, new message dispatched", async () => {
    const configResult = validateVoiceConfig(RAW_CONFIG);
    if (!configResult.ok) return;

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(configResult.value, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    // Agent starts speaking
    await adapter.send({ content: [{ kind: "text", text: "Agent response" }] });
    expect(pipeline.isSpeaking()).toBe(true);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Agent response");

    // User barges in
    pipeline.emitTranscript(createMockTranscript("User interrupts"));

    // interrupt should have been called
    expect(pipeline.mocks.interrupt).toHaveBeenCalledTimes(1);
    expect(pipeline.isSpeaking()).toBe(false);

    // New inbound message should be dispatched
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    const msg = received[0] as {
      readonly content: readonly { readonly kind: string; readonly text: string }[];
    };
    expect(msg.content[0]?.text).toBe("User interrupts");

    // Agent can respond cleanly after barge-in
    await adapter.send({ content: [{ kind: "text", text: "New agent response" }] });
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("New agent response");

    await adapter.disconnect();
  });

  test("error recovery: STT failure surfaces in handler error", async () => {
    const configResult = validateVoiceConfig(RAW_CONFIG);
    if (!configResult.ok) return;

    const errors: unknown[] = [];
    const config: VoiceChannelConfig = {
      ...configResult.value,
      onHandlerError: (err) => errors.push(err),
    };

    const { pipeline, roomService, tokenGen } = makeIntegrationSetup();
    const adapter = createVoiceChannel(config, {
      pipeline,
      roomService,
      tokenGenerator: tokenGen,
    });

    await adapter.connect();
    await adapter.createSession();

    // Register a handler that throws
    adapter.onMessage(async () => {
      throw new Error("Processing failed");
    });

    pipeline.emitTranscript(createMockTranscript("Trigger error"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(1);

    await adapter.disconnect();
  });
});
