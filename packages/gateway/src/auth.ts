/**
 * Authentication: handshake + periodic heartbeat re-validation.
 */

import {
  buildAckFrame,
  buildErrorFrame,
  negotiateProtocol,
  parseConnectFrame,
} from "./protocol.js";
import type { SessionStore } from "./session-store.js";
import type { TransportConnection } from "./transport.js";
import type {
  AuthResult,
  ConnectFrame,
  GatewayCapabilities,
  HandshakeAckPayload,
  HandshakeSnapshot,
  Session,
} from "./types.js";

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

export interface HandshakeOptions {
  readonly minProtocolVersion: number;
  readonly maxProtocolVersion: number;
  readonly capabilities: GatewayCapabilities;
  readonly snapshot?: HandshakeSnapshot;
}

export interface HandshakeResult {
  readonly session: Session;
  readonly connectFrame: ConnectFrame;
}

/**
 * Wait for the first message on a connection to be a structured ConnectFrame.
 * Negotiates protocol version, then delegates to the authenticator.
 * Resolves with a new Session on success, rejects on failure/timeout.
 */
export function handleHandshake(
  conn: TransportConnection,
  authenticator: GatewayAuthenticator,
  timeoutMs: number,
  options: HandshakeOptions,
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
        conn.send(buildErrorFrame(0, parseResult.error.code, parseResult.error.message));
        conn.close(4002, "Invalid connect frame");
        reject(new Error(`Invalid connect frame: ${parseResult.error.message}`));
        return;
      }

      const connectFrame = parseResult.value;

      // Negotiate protocol version before auth
      const versionResult = negotiateProtocol(
        connectFrame.minProtocol,
        connectFrame.maxProtocol,
        options.minProtocolVersion,
        options.maxProtocolVersion,
      );
      if (!versionResult.ok) {
        conn.send(buildErrorFrame(0, "PROTOCOL_MISMATCH", versionResult.error.message));
        conn.close(4010, "Protocol version mismatch");
        reject(new Error(`Protocol mismatch: ${versionResult.error.message}`));
        return;
      }

      const negotiatedVersion = versionResult.value;

      void authenticator
        .authenticate(connectFrame)
        .then((result) => {
          if (!result.ok) {
            conn.send(buildErrorFrame(0, result.code, result.message));
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
            ...(result.routing !== undefined ? { routing: result.routing } : {}),
          };

          const ackPayload: HandshakeAckPayload = {
            sessionId: session.id,
            protocol: negotiatedVersion,
            capabilities: options.capabilities,
            ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
          };
          conn.send(buildAckFrame(0, undefined, ackPayload));
          resolve({ session, connectFrame });
        })
        .catch((err: unknown) => {
          conn.send(buildErrorFrame(0, "INTERNAL", "Authentication service error"));
          conn.close(4003, "INTERNAL");
          reject(new Error("Auth service error", { cause: err }));
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
const SHARD_COUNT = 10;

/** Contextual information passed to the sweep error handler. */
export interface SweepError {
  readonly sessionId: string;
  readonly cause: unknown;
}

export function startHeartbeatSweep(
  store: SessionStore,
  authenticator: GatewayAuthenticator,
  heartbeatIntervalMs: number,
  sweepIntervalMs: number,
  onExpired: (sessionId: string) => void,
  onError?: (error: SweepError) => void,
): () => void {
  let shardIndex = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const currentShard = shardIndex;
    shardIndex = (shardIndex + 1) % SHARD_COUNT;

    let i = 0;
    for (const [id, session] of store.entries()) {
      if (i++ % SHARD_COUNT !== currentShard) continue;
      if (now - session.lastHeartbeat < heartbeatIntervalMs) continue;

      void authenticator
        .validate(id)
        .then((valid) => {
          if (!valid) {
            store.delete(id);
            onExpired(id);
          } else {
            // Update heartbeat timestamp
            store.set({ ...session, lastHeartbeat: Date.now() });
          }
        })
        .catch((cause: unknown) => {
          // Fail-open: auth service error → keep session alive, retry next sweep.
          // Notify caller for logging/metrics — never silently swallow.
          onError?.({ sessionId: id, cause });
        });
    }
  }, sweepIntervalMs);

  return () => clearInterval(timer);
}
