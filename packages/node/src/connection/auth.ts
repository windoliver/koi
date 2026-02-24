/**
 * WebSocket auth handshake — token + optional HMAC challenge/response.
 *
 * Auth flow:
 * 1. Node sends `node:auth` with { token, timestamp }
 * 2. Gateway responds with either:
 *    - `node:auth_ack` { success: true }  — token-only auth accepted
 *    - `node:auth_challenge` { challenge } — HMAC verification required
 * 3. If challenged, Node sends `node:auth_response` { response: HMAC-SHA256(challenge, secret) }
 * 4. Gateway sends `node:auth_ack` { success: true/false }
 *
 * Uses Web Crypto API (available natively in Bun) for HMAC-SHA256.
 */

import type { AuthConfig, AuthPayload, NodeFrame } from "../types.js";
import { generateCorrelationId } from "./protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auth config accepted by the handshake (secret is optional). */
export type AuthHandshakeConfig = Pick<AuthConfig, "token" | "timeoutMs"> & {
  readonly secret?: string | undefined;
};

export interface AuthHandshake {
  /** Start the auth handshake. Resolves on success, rejects on failure/timeout. */
  readonly start: (sendFrame: (frame: NodeFrame) => void) => Promise<void>;
  /** Feed a received frame into the auth state machine. */
  readonly handleFrame: (frame: NodeFrame) => void;
  /** Cancel the handshake and clean up timers. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing
// ---------------------------------------------------------------------------

/** Sign a challenge string with HMAC-SHA256, returning a lowercase hex string. */
export async function signChallenge(challenge: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(challenge));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Narrow unknown to Record<string, unknown> without `as Type` assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Auth payload helper
// ---------------------------------------------------------------------------

/** Create the initial auth payload with token and current timestamp. */
export function createAuthPayload(token: string): AuthPayload {
  return { token, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Auth handshake state machine
// ---------------------------------------------------------------------------

export function createAuthHandshake(nodeId: string, config: AuthHandshakeConfig): AuthHandshake {
  // let: mutable state machine — transitions: pending → authenticating → done
  let state: "pending" | "authenticating" | "done" = "pending";
  // let: set once in start(), cleared on completion/timeout/dispose
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // let: set once in start(), called on success
  let resolveAuth: (() => void) | undefined;
  // let: set once in start(), called on failure/timeout
  let rejectAuth: ((err: Error) => void) | undefined;
  // let: set once in start(), used to send response frames
  let sendFn: ((frame: NodeFrame) => void) | undefined;

  function cleanup(): void {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  }

  function complete(): void {
    state = "done";
    cleanup();
    if (resolveAuth !== undefined) {
      resolveAuth();
      resolveAuth = undefined;
      rejectAuth = undefined;
    }
  }

  function fail(reason: string): void {
    state = "done";
    cleanup();
    if (rejectAuth !== undefined) {
      rejectAuth(new Error(reason));
      resolveAuth = undefined;
      rejectAuth = undefined;
    }
  }

  function handleAck(payload: unknown): void {
    if (!isRecord(payload)) {
      fail("auth rejected");
      return;
    }
    if (payload.success === true) {
      complete();
    } else {
      const reason = typeof payload.reason === "string" ? payload.reason : "auth rejected";
      fail(reason);
    }
  }

  function handleChallenge(payload: unknown): void {
    if (!isRecord(payload)) {
      fail("invalid challenge payload");
      return;
    }
    if (typeof payload.challenge !== "string") {
      fail("invalid challenge payload");
      return;
    }

    if (config.secret === undefined) {
      fail("received challenge but no secret configured");
      return;
    }

    const challengeStr = payload.challenge;

    // Sign asynchronously and send response
    void signChallenge(challengeStr, config.secret)
      .then((response) => {
        if (state === "done" || sendFn === undefined) return;
        sendFn({
          nodeId,
          agentId: "",
          correlationId: generateCorrelationId(nodeId),
          kind: "node:auth_response",
          payload: { response } satisfies { readonly response: string },
        });
      })
      .catch((err: unknown) => {
        fail(`HMAC signing failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  return {
    start(sendFrame) {
      if (state !== "pending") {
        return Promise.reject(new Error("auth handshake already started"));
      }

      state = "authenticating";
      sendFn = sendFrame;

      // Send initial auth frame
      sendFrame({
        nodeId,
        agentId: "",
        correlationId: generateCorrelationId(nodeId),
        kind: "node:auth",
        payload: createAuthPayload(config.token),
      });

      return new Promise<void>((resolve, reject) => {
        resolveAuth = resolve;
        rejectAuth = reject;

        // Timeout guard
        timeoutId = setTimeout(() => {
          fail("auth timed out");
        }, config.timeoutMs);
      });
    },

    handleFrame(frame) {
      if (state !== "authenticating") return;

      switch (frame.kind) {
        case "node:auth_ack":
          handleAck(frame.payload);
          break;
        case "node:auth_challenge":
          handleChallenge(frame.payload);
          break;
        default:
          // Ignore unrelated frame kinds
          break;
      }
    },

    dispose() {
      if (state !== "done") {
        fail("auth disposed");
      }
    },
  };
}
