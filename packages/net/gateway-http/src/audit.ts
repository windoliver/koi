import type { AuditEntry } from "@koi/core";
import type { AuthAuditResult } from "./types.js";

/**
 * Gateway audit schema version. Increment when GatewayRequestRecord shape
 * or the produced AuditEntry metadata layout changes.
 */
export const GATEWAY_AUDIT_SCHEMA_VERSION = 1;

export interface GatewayRequestRecord {
  readonly timestamp: number;
  readonly kind: "gateway.request" | "gateway.ws_upgrade";
  readonly channel?: string;
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly authResult: AuthAuditResult;
  readonly sessionId?: string;
  readonly remoteAddr?: string;
}

/**
 * Build an AuditEntry for a gateway HTTP/WS request event.
 *
 * Gateway requests are pre-agent (no agentId/turnIndex available at the edge),
 * so we record the entry with stable defaults: agentId="gateway", turnIndex=0,
 * sessionId="anonymous" when the request is unauthenticated.
 */
export function buildGatewayRequestEntry(r: GatewayRequestRecord): AuditEntry {
  return {
    schema_version: GATEWAY_AUDIT_SCHEMA_VERSION,
    timestamp: r.timestamp,
    sessionId: r.sessionId ?? "anonymous",
    agentId: "gateway",
    turnIndex: 0,
    kind: r.kind,
    durationMs: r.latencyMs,
    metadata: {
      ...(r.channel !== undefined ? { channel: r.channel } : {}),
      path: r.path,
      method: r.method,
      status: r.status,
      authResult: r.authResult,
      ...(r.remoteAddr !== undefined ? { remoteAddr: r.remoteAddr } : {}),
    },
  };
}
