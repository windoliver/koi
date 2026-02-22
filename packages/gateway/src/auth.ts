/**
 * Authentication: handshake + periodic heartbeat re-validation.
 */

import { encodeFrame, parseConnectFrame } from "./protocol.js";
import type { SessionStore } from "./session-store.js";
import type { TransportConnection } from "./transport.js";
import type { AuthResult, ConnectFrame, Session } from "./types.js";

// ---------------------------------------------------------------------------
// Authenticator interface
// ---------------------------------------------------------------------------

export interface GatewayAuthenticator {
  /** Authenticate based on a structured connect frame. */
  readonly authenticate: (frame: ConnectFrame) => Promise<AuthResult>;
  /** Re-validate an existing session (heartbeat check). */
  readonly validate: (sessionId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface HandshakeResult {
  readonly session: Session;
  readonly connectFrame: ConnectFrame;
}

/**
 * Wait for the first message on a connection to be a structured ConnectFrame.
 * Parses + validates the frame, then delegates to the authenticator.
 * Resolves with a new Session on success, rejects on failure/timeout.
 */
export function handleHandshake(
  conn: TransportConnection,
  authenticator: GatewayAuthenticator,
  timeoutMs: number,
  protocolVersion: number,
  onMessage: (handler: (data: string) => void) => void,
): Promise<HandshakeResult> {
  return new Promise<HandshakeResult>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.close(4001, "Auth timeout");
      reject(new Error("Auth handshake timed out"));
    }, timeoutMs);

    onMessage((data: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Parse the structured connect frame
      const parseResult = parseConnectFrame(data);
      if (!parseResult.ok) {
        const errorFrame = encodeFrame({
          kind: "error",
          id: crypto.randomUUID(),
          seq: 0,
          timestamp: Date.now(),
          payload: { code: parseResult.error.code, message: parseResult.error.message },
        });
        conn.send(errorFrame);
        conn.close(4002, "Invalid connect frame");
        reject(new Error(`Invalid connect frame: ${parseResult.error.message}`));
        return;
      }

      const connectFrame = parseResult.value;

      void authenticator.authenticate(connectFrame).then((result) => {
        if (!result.ok) {
          const errorFrame = encodeFrame({
            kind: "error",
            id: crypto.randomUUID(),
            seq: 0,
            timestamp: Date.now(),
            payload: { code: result.code, message: result.message },
          });
          conn.send(errorFrame);
          conn.close(4003, result.code);
          reject(new Error(`Auth failed: ${result.code}`));
          return;
        }

        const session: Session = {
          id: result.sessionId,
          agentId: result.agentId,
          connectedAt: Date.now(),
          lastHeartbeat: Date.now(),
          seq: 0,
          remoteSeq: 0,
          metadata: result.metadata,
        };

        const ackFrame = encodeFrame({
          kind: "ack",
          id: crypto.randomUUID(),
          seq: 0,
          timestamp: Date.now(),
          payload: { sessionId: session.id, protocol: protocolVersion },
        });
        conn.send(ackFrame);

        resolve({ session, connectFrame });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Heartbeat sweep
// ---------------------------------------------------------------------------

/**
 * Start a periodic sweep that re-validates sessions.
 * Sessions that fail validation are closed via the provided callback.
 * Returns a cleanup function to stop the sweep.
 */
export function startHeartbeatSweep(
  store: SessionStore,
  authenticator: GatewayAuthenticator,
  heartbeatIntervalMs: number,
  sweepIntervalMs: number,
  onExpired: (sessionId: string) => void,
): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of store.entries()) {
      if (now - session.lastHeartbeat < heartbeatIntervalMs) continue;

      void authenticator.validate(id).then((valid) => {
        if (!valid) {
          store.delete(id);
          onExpired(id);
        } else {
          // Update heartbeat timestamp
          store.set({ ...session, lastHeartbeat: Date.now() });
        }
      });
    }
  }, sweepIntervalMs);

  return () => clearInterval(timer);
}
