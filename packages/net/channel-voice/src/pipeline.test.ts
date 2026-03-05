/**
 * Unit tests for VoicePipeline using mock implementation.
 *
 * These tests verify the VoicePipeline contract using createMockVoicePipeline.
 * The LiveKit implementation is tested via integration tests.
 */

import { describe, expect, test } from "bun:test";
import { createMockTranscript, createMockVoicePipeline } from "./test-helpers.js";

describe("VoicePipeline (mock)", () => {
  test("start() marks pipeline as running", async () => {
    const pipeline = createMockVoicePipeline();
    expect(pipeline.isRunning()).toBe(false);
    await pipeline.start("test-room");
    expect(pipeline.isRunning()).toBe(true);
  });

  test("stop() marks pipeline as not running", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.start("test-room");
    await pipeline.stop();
    expect(pipeline.isRunning()).toBe(false);
  });

  test("double start() is idempotent", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.start("room-1");
    await pipeline.start("room-2");
    expect(pipeline.mocks.start).toHaveBeenCalledTimes(2);
    expect(pipeline.isRunning()).toBe(true);
  });

  test("stop() while not running is no-op", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.stop();
    expect(pipeline.mocks.stop).toHaveBeenCalledTimes(1);
    expect(pipeline.isRunning()).toBe(false);
  });

  test("onTranscript() callback fires when transcript emitted", async () => {
    const pipeline = createMockVoicePipeline();
    const received: unknown[] = [];
    pipeline.onTranscript((event) => received.push(event));

    const transcript = createMockTranscript("Hello");
    pipeline.emitTranscript(transcript);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(transcript);
  });

  test("onTranscript() unsubscribe stops receiving events", () => {
    const pipeline = createMockVoicePipeline();
    const received: unknown[] = [];
    const unsub = pipeline.onTranscript((event) => received.push(event));

    pipeline.emitTranscript(createMockTranscript("First"));
    unsub();
    pipeline.emitTranscript(createMockTranscript("Second"));

    expect(received).toHaveLength(1);
  });

  test("multiple handlers all receive events", () => {
    const pipeline = createMockVoicePipeline();
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    pipeline.onTranscript((event) => received1.push(event));
    pipeline.onTranscript((event) => received2.push(event));

    pipeline.emitTranscript(createMockTranscript("Test"));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test("speak() is recorded by mock", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.speak("Hello world");
    expect(pipeline.mocks.speak).toHaveBeenCalledTimes(1);
    expect(pipeline.mocks.speak).toHaveBeenCalledWith("Hello world");
  });

  test("double unsubscribe is safe", () => {
    const pipeline = createMockVoicePipeline();
    const unsub = pipeline.onTranscript(() => {});
    unsub();
    unsub(); // should not throw
  });

  test("isSpeaking() returns false initially", () => {
    const pipeline = createMockVoicePipeline();
    expect(pipeline.isSpeaking()).toBe(false);
  });

  test("isSpeaking() returns true after speak()", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.speak("Hello");
    expect(pipeline.isSpeaking()).toBe(true);
  });

  test("interrupt() sets isSpeaking to false", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.speak("Hello");
    expect(pipeline.isSpeaking()).toBe(true);
    pipeline.interrupt();
    expect(pipeline.isSpeaking()).toBe(false);
  });

  test("interrupt() while not speaking is no-op", () => {
    const pipeline = createMockVoicePipeline();
    pipeline.interrupt(); // should not throw
    expect(pipeline.isSpeaking()).toBe(false);
    expect(pipeline.mocks.interrupt).toHaveBeenCalledTimes(1);
  });

  test("stop() resets isSpeaking to false", async () => {
    const pipeline = createMockVoicePipeline();
    await pipeline.speak("Hello");
    expect(pipeline.isSpeaking()).toBe(true);
    await pipeline.stop();
    expect(pipeline.isSpeaking()).toBe(false);
  });
});
