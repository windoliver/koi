/**
 * Unit tests for room management.
 */

import { describe, expect, test } from "bun:test";
import type { VoiceChannelConfig } from "./config.js";
import { createRoomManager } from "./room.js";
import { createMockRoomService, createMockTokenGenerator } from "./test-helpers.js";

const BASE_CONFIG: VoiceChannelConfig = {
  livekitUrl: "wss://livekit.example.com",
  livekitApiKey: "api-key",
  livekitApiSecret: "api-secret",
  stt: { provider: "deepgram", apiKey: "dg-key" },
  tts: { provider: "openai", apiKey: "oai-key" },
  maxConcurrentSessions: 3,
  roomEmptyTimeoutSeconds: 60,
};

describe("createRoomManager", () => {
  test("createSession() returns roomName, token, and wsUrl", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    const result = await manager.createSession();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.roomName).toMatch(/^voice-/);
      expect(result.value.token).toMatch(/^mock-jwt-/);
      expect(result.value.wsUrl).toBe("wss://livekit.example.com");
    }
  });

  test("createSession() calls roomService.createRoom", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    await manager.createSession();
    expect(roomService.mocks.createRoom).toHaveBeenCalledTimes(1);
  });

  test("createSession() at max capacity returns RATE_LIMIT error", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    // Fill to capacity (3)
    await manager.createSession();
    await manager.createSession();
    await manager.createSession();

    const result = await manager.createSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("endSession() removes room from tracking", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    const result = await manager.createSession();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(manager.activeSessions()).toBe(1);
    await manager.endSession(result.value.roomName);
    expect(manager.activeSessions()).toBe(0);
  });

  test("endSession() calls roomService.deleteRoom", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    const result = await manager.createSession();
    if (!result.ok) return;

    await manager.endSession(result.value.roomName);
    expect(roomService.mocks.deleteRoom).toHaveBeenCalledTimes(1);
  });

  test("endSession() on unknown room is no-op (idempotent)", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    await manager.endSession("nonexistent-room");
    expect(roomService.mocks.deleteRoom).toHaveBeenCalledTimes(0);
  });

  test("activeSessions() reflects creates and ends", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    expect(manager.activeSessions()).toBe(0);

    const r1 = await manager.createSession();
    expect(manager.activeSessions()).toBe(1);

    const r2 = await manager.createSession();
    expect(manager.activeSessions()).toBe(2);

    if (r1.ok) await manager.endSession(r1.value.roomName);
    expect(manager.activeSessions()).toBe(1);

    if (r2.ok) await manager.endSession(r2.value.roomName);
    expect(manager.activeSessions()).toBe(0);
  });

  test("endAllSessions() clears all sessions", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    await manager.createSession();
    await manager.createSession();
    expect(manager.activeSessions()).toBe(2);

    await manager.endAllSessions();
    expect(manager.activeSessions()).toBe(0);
  });
});

describe("createRoomManager — cleanup sweep", () => {
  test("stopCleanupSweep() stops the interval", () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    manager.startCleanupSweep();
    manager.stopCleanupSweep();

    // Double stop is safe
    manager.stopCleanupSweep();
  });

  test("startCleanupSweep() is idempotent", () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    manager.startCleanupSweep();
    manager.startCleanupSweep(); // should not create second interval
    manager.stopCleanupSweep();
  });

  test("stale sessions are cleaned up by endSession", async () => {
    const roomService = createMockRoomService();
    const tokenGen = createMockTokenGenerator();
    const manager = createRoomManager(BASE_CONFIG, { roomService, tokenGenerator: tokenGen });

    const result = await manager.createSession();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(manager.activeSessions()).toBe(1);

    // Directly end the session (simulates what cleanup sweep does)
    await manager.endSession(result.value.roomName);
    expect(manager.activeSessions()).toBe(0);
    expect(roomService.mocks.deleteRoom).toHaveBeenCalledTimes(1);
  });
});
