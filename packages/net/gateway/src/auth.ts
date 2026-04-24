/**
 * Authentication: handshake orchestration.
 *
 * Heartbeat re-validation is omitted in this minimal v2 gateway — sessions are
 * stateless tokens. Add a sweep if re-validation is needed in a future issue.
 */

import { CLOSE_CODES } from "./close-codes.js";
import {
  createAckFrame,
  createErrorFrame,
  negotiateProtocol,
  parseConnectFrame,
} from "./protocol.js";
import type { TransportConnection } from "./transport.js";
import type {
  AuthResult,
  ConnectFrame,
  GatewayCapabilities,
  HandshakeAckPayload,
  HandshakeSnapshot,
  Session,
} from "./types.js";

export interface GatewayAuthenticator {
  readonly authenticate: (frame: ConnectFrame) => Promise<AuthResult>;
  /** Called periodically for each live session. Return false to revoke access. */
  readonly validate?: (session: Session) => boolean | Promise<boolean>;
}

export interface HandshakeOptions {
  readonly minProtocolVersion: number;
  readonly maxProtocolVersion: number;
  readonly capabilities: GatewayCapabilities;
  readonly snapshot?: HandshakeSnapshot | undefined;
}

export interface HandshakeResult {
  readonly session: Session;
  readonly connectFrame: ConnectFrame;
  /** Send the handshake ack with the given server outbound seq. Returns transport byte count. */
  readonly sendAck: (seq: number) => number;
}

/**
 * Wait for the first message on a connection and perform auth handshake.
 * Resolves with the new Session on success, rejects on timeout or failure.
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
    let connectFrameSeen = false;

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }

    // Timer covers the entire handshake: first-message wait + authenticate() duration.
    const timer = setTimeout(() => {
      settle(() => {
        conn.close(CLOSE_CODES.AUTH_TIMEOUT, "Auth timeout");
        reject(new Error("Auth handshake timed out"));
      });
    }, timeoutMs);

    onMessage((data: string) => {
      if (settled) return;
      // Reject any traffic that arrives before the handshake ack is sent. A well-behaved
      // client waits for the ack before sending application frames; any frame here indicates
      // a protocol violation, so we close with a deterministic error rather than dropping
      // silently (which would leave the client unable to distinguish loss from discard).
      if (connectFrameSeen) {
        settle(() => {
          conn.send(
            createErrorFrame(0, "INVALID_HANDSHAKE", "Frame received before handshake complete"),
          );
          conn.close(CLOSE_CODES.INVALID_HANDSHAKE, "Frame received before handshake complete");
          reject(new Error("Frame received before handshake complete"));
        });
        return;
      }
      connectFrameSeen = true;

      const parseResult = parseConnectFrame(data);
      if (!parseResult.ok) {
        settle(() => {
          conn.send(createErrorFrame(0, parseResult.error.code, parseResult.error.message));
          conn.close(CLOSE_CODES.INVALID_HANDSHAKE, "Invalid connect frame");
          reject(new Error(`Invalid connect frame: ${parseResult.error.message}`));
        });
        return;
      }

      const connectFrame = parseResult.value;

      const versionResult = negotiateProtocol(
        connectFrame.minProtocol,
        connectFrame.maxProtocol,
        options.minProtocolVersion,
        options.maxProtocolVersion,
      );
      if (!versionResult.ok) {
        settle(() => {
          conn.send(createErrorFrame(0, "PROTOCOL_MISMATCH", versionResult.error.message));
          conn.close(CLOSE_CODES.PROTOCOL_MISMATCH, "Protocol version mismatch");
          reject(new Error(`Protocol mismatch: ${versionResult.error.message}`));
        });
        return;
      }

      const negotiatedVersion = versionResult.value;

      void authenticator
        .authenticate(connectFrame)
        .then((result) => {
          if (!result.ok) {
            settle(() => {
              conn.send(createErrorFrame(0, result.code, result.message));
              conn.close(CLOSE_CODES.AUTH_FAILED, result.code);
              reject(new Error(`Auth failed: ${result.code}`));
            });
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

          settle(() => {
            resolve({
              session,
              connectFrame,
              sendAck: (seq: number) => conn.send(createAckFrame(seq, undefined, ackPayload)),
            });
          });
        })
        .catch((err: unknown) => {
          settle(() => {
            conn.send(createErrorFrame(0, "INTERNAL", "Authentication service error"));
            conn.close(CLOSE_CODES.AUTH_FAILED, "INTERNAL");
            reject(new Error("Auth service error", { cause: err }));
          });
        });
    });
  });
}
