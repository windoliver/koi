/**
 * Unit tests for the WebSocket auth handshake module.
 *
 * Tests HMAC signing, auth payload creation, and the auth handshake
 * state machine (token-only, challenge/response, timeout, rejection).
 */

import { describe, expect, it } from "bun:test";
import type { AuthAckPayload, AuthChallengePayload, NodeFrame } from "../types.js";
import { createAuthHandshake, createAuthPayload, signChallenge } from "./auth.js";

// ---------------------------------------------------------------------------
// signChallenge
// ---------------------------------------------------------------------------

describe("signChallenge", () => {
  it("produces a hex-encoded HMAC-SHA256", async () => {
    const result = await signChallenge("test-challenge", "my-secret");
    // Hex string: 64 chars for SHA-256
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output for same inputs", async () => {
    const a = await signChallenge("challenge-1", "secret-1");
    const b = await signChallenge("challenge-1", "secret-1");
    expect(a).toBe(b);
  });

  it("produces different output for different challenges", async () => {
    const a = await signChallenge("challenge-1", "secret-1");
    const b = await signChallenge("challenge-2", "secret-1");
    expect(a).not.toBe(b);
  });

  it("produces different output for different secrets", async () => {
    const a = await signChallenge("challenge-1", "secret-1");
    const b = await signChallenge("challenge-1", "secret-2");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// createAuthPayload
// ---------------------------------------------------------------------------

describe("createAuthPayload", () => {
  it("creates payload with token and timestamp", () => {
    const before = Date.now();
    const payload = createAuthPayload("my-token");
    const after = Date.now();

    expect(payload.token).toBe("my-token");
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// createAuthHandshake — state machine
// ---------------------------------------------------------------------------

describe("createAuthHandshake", () => {
  const nodeId = "node-test";

  describe("token-only auth (no secret)", () => {
    it("sends auth frame and resolves on ack success", async () => {
      const sentFrames: NodeFrame[] = [];
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-123",
        timeoutMs: 5_000,
      });

      const promise = handshake.start((frame) => {
        sentFrames.push(frame);
      });

      // Should have sent node:auth frame
      expect(sentFrames.length).toBe(1);
      expect(sentFrames[0]?.kind).toBe("node:auth");
      const authPayload = sentFrames[0]?.payload as { token: string; timestamp: number };
      expect(authPayload.token).toBe("tok-123");
      expect(typeof authPayload.timestamp).toBe("number");

      // Simulate Gateway ack
      const ackPayload: AuthAckPayload = { success: true };
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-1",
        kind: "node:auth_ack",
        payload: ackPayload,
      });

      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects on ack failure", async () => {
      const handshake = createAuthHandshake(nodeId, {
        token: "bad-token",
        timeoutMs: 5_000,
      });

      const promise = handshake.start(() => {});

      const ackPayload: AuthAckPayload = { success: false, reason: "invalid token" };
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-1",
        kind: "node:auth_ack",
        payload: ackPayload,
      });

      await expect(promise).rejects.toThrow("invalid token");
    });
  });

  describe("challenge/response auth (with secret)", () => {
    it("responds to challenge with HMAC and resolves on ack", async () => {
      const sentFrames: NodeFrame[] = [];
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-456",
        secret: "my-hmac-secret",
        timeoutMs: 5_000,
      });

      const promise = handshake.start((frame) => {
        sentFrames.push(frame);
      });

      // Initial auth frame sent
      expect(sentFrames.length).toBe(1);
      expect(sentFrames[0]?.kind).toBe("node:auth");

      // Simulate Gateway challenge
      const challengePayload: AuthChallengePayload = { challenge: "nonce-abc-123" };
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-2",
        kind: "node:auth_challenge",
        payload: challengePayload,
      });

      // Wait for async HMAC computation
      await new Promise((r) => setTimeout(r, 50));

      // Should have sent node:auth_response
      expect(sentFrames.length).toBe(2);
      expect(sentFrames[1]?.kind).toBe("node:auth_response");
      const responsePayload = sentFrames[1]?.payload as { response: string };
      expect(responsePayload.response).toMatch(/^[0-9a-f]{64}$/);

      // Verify HMAC is correct
      const expected = await signChallenge("nonce-abc-123", "my-hmac-secret");
      expect(responsePayload.response).toBe(expected);

      // Simulate Gateway ack
      const ackPayload: AuthAckPayload = { success: true };
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-3",
        kind: "node:auth_ack",
        payload: ackPayload,
      });

      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("timeout", () => {
    it("rejects if auth not completed within timeoutMs", async () => {
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-slow",
        timeoutMs: 50,
      });

      const promise = handshake.start(() => {});
      // Don't send any response — let it timeout

      await expect(promise).rejects.toThrow("timed out");
    });
  });

  describe("cleanup", () => {
    it("dispose clears timeout and rejects pending promise", async () => {
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-dispose",
        timeoutMs: 60_000,
      });

      const promise = handshake.start(() => {});
      handshake.dispose();

      await expect(promise).rejects.toThrow("disposed");
    });

    it("ignores frames after completion", async () => {
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-done",
        timeoutMs: 5_000,
      });

      const promise = handshake.start(() => {});

      // Complete the handshake
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-1",
        kind: "node:auth_ack",
        payload: { success: true } satisfies AuthAckPayload,
      });

      await promise;

      // Send another frame — should not throw
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-2",
        kind: "node:auth_ack",
        payload: { success: false, reason: "late" } satisfies AuthAckPayload,
      });
    });

    it("ignores unrelated frame types", async () => {
      const handshake = createAuthHandshake(nodeId, {
        token: "tok-ignore",
        timeoutMs: 5_000,
      });

      const promise = handshake.start(() => {});

      // Send unrelated frame — should be ignored
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-1",
        kind: "node:heartbeat",
        payload: { kind: "pong" },
      });

      // Complete normally
      handshake.handleFrame({
        nodeId,
        agentId: "",
        correlationId: "gw-2",
        kind: "node:auth_ack",
        payload: { success: true } satisfies AuthAckPayload,
      });

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
