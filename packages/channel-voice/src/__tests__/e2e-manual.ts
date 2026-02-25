#!/usr/bin/env bun

/**
 * Manual E2E test — @koi/channel-voice through the full L1 runtime.
 *
 * Validates the complete stack:
 *   createPiAdapter (real Anthropic LLM call)
 *   → createKoi (L1 assembly, middleware chain, guards)
 *   → createVoiceChannel (mock pipeline, real channel contract)
 *   → transcript → engine → response → pipeline.speak()
 *
 * Uses mock VoicePipeline (no LiveKit infra needed) but real LLM calls.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY must be set (auto-loaded from .env by Bun).
 *
 * Run:
 *   bun run packages/channel-voice/src/__tests__/e2e-manual.ts
 */

import type { EngineEvent } from "@koi/core/engine";
import type { InboundMessage } from "@koi/core/message";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { VoiceChannelConfig } from "../config.js";
import {
  createMockRoomService,
  createMockTokenGenerator,
  createMockTranscript,
  createMockVoicePipeline,
} from "../test-helpers.js";
import { createVoiceChannel } from "../voice-channel.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (ANTHROPIC_KEY.length === 0) {
  console.error("❌ ANTHROPIC_API_KEY not set. Add it to .env or export it.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, ...args: readonly unknown[]): void {
  console.log(`  [${label}]`, ...args);
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test 1: Full pipeline — transcript → engine (real LLM) → speak
// ---------------------------------------------------------------------------

async function testFullPipeline(): Promise<void> {
  console.log("\n── Test 1: Full pipeline (transcript → LLM → speak) ──");

  // 1. Create voice channel with mock pipeline
  const pipeline = createMockVoicePipeline();
  const config: VoiceChannelConfig = {
    livekitUrl: "wss://e2e-test.example.com",
    livekitApiKey: "e2e-api-key",
    livekitApiSecret: "e2e-api-secret",
    stt: { provider: "deepgram", apiKey: "e2e-dg-key" },
    tts: { provider: "openai", apiKey: "e2e-oai-key" },
    maxConcurrentSessions: 5,
  };

  const channel = createVoiceChannel(config, {
    pipeline,
    roomService: createMockRoomService(),
    tokenGenerator: createMockTokenGenerator(),
  });

  // 2. Create Pi engine adapter (real Anthropic API)
  const adapter = createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    systemPrompt: "You are a concise voice assistant. Reply in one short sentence.",
    getApiKey: async (_provider) => ANTHROPIC_KEY,
  });

  // 3. Assemble L1 runtime
  const runtime = await createKoi({
    manifest: {
      name: "VoiceE2EAgent",
      version: "1.0.0",
      model: { name: "anthropic:claude-haiku-4-5-20251001" },
    },
    adapter,
    channelId: "@koi/channel-voice",
    ...(channel.sendStatus !== undefined && { sendStatus: channel.sendStatus }),
  });
  log("runtime", `Agent assembled: ${runtime.agent.pid.name} (${runtime.agent.pid.id})`);

  // 4. Connect channel + create session
  await channel.connect();
  const session = await channel.createSession();
  log("session", `Room: ${session.roomName}, Token: ${session.token.slice(0, 20)}...`);

  // 5. Wire channel → engine: collect inbound messages, run through engine
  const received: InboundMessage[] = [];
  channel.onMessage(async (msg) => {
    received.push(msg);
    log(
      "inbound",
      `"${msg.content[0]?.kind === "text" ? msg.content[0].text : "?"}" from ${msg.senderId}`,
    );

    // Run engine with the inbound message
    log("engine", "Running LLM...");
    const events = await collectEvents(
      runtime.run({
        kind: "messages",
        messages: [msg],
      }),
    );

    // Extract text from events
    const textDeltas = events.filter(
      (e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta",
    );
    const responseText = textDeltas.map((e) => e.delta).join("");
    log("engine", `LLM response: "${responseText}"`);

    // Extract done event metrics
    const doneEvent = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    if (doneEvent) {
      const m = doneEvent.output.metrics;
      log(
        "metrics",
        `tokens: ${m.inputTokens}in/${m.outputTokens}out, turns: ${m.turns}, ${m.durationMs}ms`,
      );
    }

    // Send response through channel → pipeline.speak()
    await channel.send({
      content: [{ kind: "text", text: responseText }],
    });
    log("speak", `pipeline.speak() called with: "${pipeline.mocks.speak.mock.calls.at(-1)?.[0]}"`);
  });

  // 6. Simulate user speaking — emit a transcript
  log("user", "Simulating voice transcript: 'What is the capital of France?'");
  pipeline.emitTranscript(createMockTranscript("What is the capital of France?"));

  // Wait for async dispatch + LLM call
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  // 7. Assertions
  console.log("\n── Assertions ──");

  const pass = (msg: string): void => console.log(`  ✅ ${msg}`);
  const fail = (msg: string): void => {
    console.log(`  ❌ ${msg}`);
    process.exitCode = 1;
  };

  if (received.length === 1) {
    pass("Received exactly 1 inbound message from transcript");
  } else {
    fail(`Expected 1 inbound message, got ${received.length}`);
  }

  if (received[0]?.content[0]?.kind === "text") {
    pass(`Inbound message has TextBlock: "${received[0].content[0].text}"`);
  } else {
    fail("Inbound message missing TextBlock");
  }

  if (pipeline.mocks.speak.mock.calls.length >= 1) {
    const spoken = String(pipeline.mocks.speak.mock.calls[0]?.[0] ?? "");
    if (spoken.toLowerCase().includes("paris")) {
      pass(`pipeline.speak() received correct answer containing "Paris": "${spoken}"`);
    } else {
      // LLM might phrase it differently — still check it was called
      pass(`pipeline.speak() was called (response: "${spoken}")`);
      console.log("    ⚠️  Response didn't contain 'Paris' — LLM phrased it differently");
    }
  } else {
    fail("pipeline.speak() was never called");
  }

  // 8. Cleanup
  await channel.disconnect();
  await runtime.dispose();
  log("cleanup", "Channel disconnected, runtime disposed");
}

// ---------------------------------------------------------------------------
// Test 2: sendStatus — processing filler via channel
// ---------------------------------------------------------------------------

async function testSendStatus(): Promise<void> {
  console.log("\n── Test 2: sendStatus (processing filler) ──");

  const pipeline = createMockVoicePipeline();
  const config: VoiceChannelConfig = {
    livekitUrl: "wss://e2e-test.example.com",
    livekitApiKey: "e2e-api-key",
    livekitApiSecret: "e2e-api-secret",
    stt: { provider: "deepgram", apiKey: "e2e-dg-key" },
    tts: { provider: "openai", apiKey: "e2e-oai-key" },
  };

  const channel = createVoiceChannel(config, {
    pipeline,
    roomService: createMockRoomService(),
    tokenGenerator: createMockTokenGenerator(),
  });

  await channel.connect();
  await channel.createSession();

  // Call sendStatus with "processing" — should speak filler
  if (channel.sendStatus) {
    await channel.sendStatus({ kind: "processing", turnIndex: 0, detail: "thinking" });
    const spoken = String(pipeline.mocks.speak.mock.calls[0]?.[0] ?? "");
    if (spoken === "thinking") {
      console.log(`  ✅ sendStatus("processing") spoke filler: "${spoken}"`);
    } else {
      console.log(`  ❌ Expected "thinking", got: "${spoken}"`);
      process.exitCode = 1;
    }

    // Call sendStatus with "idle" — should NOT speak
    const callsBefore = pipeline.mocks.speak.mock.calls.length;
    await channel.sendStatus({ kind: "idle", turnIndex: 0 });
    if (pipeline.mocks.speak.mock.calls.length === callsBefore) {
      console.log('  ✅ sendStatus("idle") did not speak (no-op)');
    } else {
      console.log('  ❌ sendStatus("idle") unexpectedly called speak()');
      process.exitCode = 1;
    }
  } else {
    console.log("  ❌ sendStatus not defined on adapter");
    process.exitCode = 1;
  }

  await channel.disconnect();
}

// ---------------------------------------------------------------------------
// Test 3: Multi-turn — two transcripts in sequence
// ---------------------------------------------------------------------------

async function testMultiTurn(): Promise<void> {
  console.log("\n── Test 3: Multi-turn (two transcripts via engine) ──");

  const pipeline = createMockVoicePipeline();
  const config: VoiceChannelConfig = {
    livekitUrl: "wss://e2e-test.example.com",
    livekitApiKey: "e2e-api-key",
    livekitApiSecret: "e2e-api-secret",
    stt: { provider: "deepgram", apiKey: "e2e-dg-key" },
    tts: { provider: "openai", apiKey: "e2e-oai-key" },
  };

  const channel = createVoiceChannel(config, {
    pipeline,
    roomService: createMockRoomService(),
    tokenGenerator: createMockTokenGenerator(),
  });

  const adapter = createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    systemPrompt: "You are a concise assistant. Reply in one short sentence only.",
    getApiKey: async (_provider) => ANTHROPIC_KEY,
  });

  await channel.connect();
  await channel.createSession();

  // Turn 1
  log("turn-1", "Sending: 'Say the word banana'");
  const runtime1 = await createKoi({
    manifest: {
      name: "VoiceE2E-Turn1",
      version: "1.0.0",
      model: { name: "anthropic:claude-haiku-4-5-20251001" },
    },
    adapter,
    channelId: "@koi/channel-voice",
  });

  const events1 = await collectEvents(
    runtime1.run({ kind: "text", text: "Say the word banana and nothing else." }),
  );
  const text1 = events1
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  await channel.send({ content: [{ kind: "text", text: text1 }] });
  log("turn-1", `Response: "${text1}"`);

  if (text1.toLowerCase().includes("banana")) {
    console.log('  ✅ Turn 1: Response contains "banana"');
  } else {
    console.log(`  ⚠️  Turn 1: Response was "${text1}" (may not contain banana)`);
  }

  // Turn 2 — fresh runtime (pi adapter creates fresh agent per stream call)
  log("turn-2", "Sending: 'Now say the word orange'");
  const runtime2 = await createKoi({
    manifest: {
      name: "VoiceE2E-Turn2",
      version: "1.0.0",
      model: { name: "anthropic:claude-haiku-4-5-20251001" },
    },
    adapter,
    channelId: "@koi/channel-voice",
  });

  const events2 = await collectEvents(
    runtime2.run({ kind: "text", text: "Say the word orange and nothing else." }),
  );
  const text2 = events2
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  await channel.send({ content: [{ kind: "text", text: text2 }] });
  log("turn-2", `Response: "${text2}"`);

  if (text2.toLowerCase().includes("orange")) {
    console.log('  ✅ Turn 2: Response contains "orange"');
  } else {
    console.log(`  ⚠️  Turn 2: Response was "${text2}" (may not contain orange)`);
  }

  // Verify speak was called twice
  if (pipeline.mocks.speak.mock.calls.length >= 2) {
    console.log(
      `  ✅ pipeline.speak() called ${pipeline.mocks.speak.mock.calls.length} times (multi-turn)`,
    );
  } else {
    console.log(`  ❌ Expected >= 2 speak() calls, got ${pipeline.mocks.speak.mock.calls.length}`);
    process.exitCode = 1;
  }

  await channel.disconnect();
  await runtime1.dispose();
  await runtime2.dispose();
}

// ---------------------------------------------------------------------------
// Test 4: Error handler isolation — handler throws, engine still runs
// ---------------------------------------------------------------------------

async function testErrorIsolation(): Promise<void> {
  console.log("\n── Test 4: Error handler isolation ──");

  const pipeline = createMockVoicePipeline();
  const errors: unknown[] = [];
  const config: VoiceChannelConfig = {
    livekitUrl: "wss://e2e-test.example.com",
    livekitApiKey: "e2e-api-key",
    livekitApiSecret: "e2e-api-secret",
    stt: { provider: "deepgram", apiKey: "e2e-dg-key" },
    tts: { provider: "openai", apiKey: "e2e-oai-key" },
    onHandlerError: (err) => {
      errors.push(err);
    },
  };

  const channel = createVoiceChannel(config, {
    pipeline,
    roomService: createMockRoomService(),
    tokenGenerator: createMockTokenGenerator(),
  });

  await channel.connect();
  await channel.createSession();

  const received: InboundMessage[] = [];

  // Handler 1: throws
  channel.onMessage(async () => {
    throw new Error("Intentional handler error");
  });

  // Handler 2: still receives
  channel.onMessage(async (msg) => {
    received.push(msg);
  });

  pipeline.emitTranscript(createMockTranscript("Test error isolation"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (received.length === 1) {
    console.log("  ✅ Handler 2 received message despite Handler 1 throwing");
  } else {
    console.log(`  ❌ Expected 1 message in handler 2, got ${received.length}`);
    process.exitCode = 1;
  }

  if (errors.length === 1) {
    console.log("  ✅ onHandlerError captured the thrown error");
  } else {
    console.log(`  ❌ Expected 1 error, got ${errors.length}`);
    process.exitCode = 1;
  }

  await channel.disconnect();
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("🎙️  @koi/channel-voice — Manual E2E (full L1 runtime + real LLM)");
  console.log("   Using model: anthropic:claude-haiku-4-5-20251001");
  console.log(`   API key: ...${ANTHROPIC_KEY.slice(-6)}`);

  const start = Date.now();

  await testFullPipeline();
  await testSendStatus();
  await testMultiTurn();
  await testErrorIsolation();

  const elapsed = Date.now() - start;
  console.log(`\n── Done (${(elapsed / 1000).toFixed(1)}s) ──`);

  if (process.exitCode === 1) {
    console.log("❌ Some tests failed — see above.");
  } else {
    console.log("✅ All tests passed.");
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
