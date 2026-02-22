/**
 * Frame codec for the Node ↔ Gateway multiplexed WebSocket protocol.
 *
 * Encodes NodeFrame to JSON string, decodes JSON string to NodeFrame.
 * All validation happens at decode time — encode trusts the caller.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NodeFrame, NodeFrameType } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_FRAME_TYPES: ReadonlySet<string> = new Set<NodeFrameType>([
  "agent:dispatch",
  "agent:message",
  "agent:status",
  "agent:terminate",
  "node:auth",
  "node:auth_challenge",
  "node:auth_response",
  "node:auth_ack",
  "node:handshake",
  "node:heartbeat",
  "node:capacity",
  "node:capabilities",
  "node:error",
  "tool_call",
  "tool_result",
  "tool_error",
]);

/** Maximum frame payload size (1 MiB). */
const MAX_FRAME_BYTES = 1_048_576;

/** Reusable decoder — avoids allocation per binary frame. */
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** Serialize a NodeFrame to a JSON string for transmission. */
export function encodeFrame(frame: NodeFrame): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** Parse and validate a raw WebSocket message into a NodeFrame. */
export function decodeFrame(raw: string | ArrayBuffer): Result<NodeFrame, KoiError> {
  const text = typeof raw === "string" ? raw : textDecoder.decode(raw);

  if (text.length > MAX_FRAME_BYTES) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Frame exceeds maximum size: ${text.length} > ${MAX_FRAME_BYTES}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame is not valid JSON",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame must be a JSON object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Safe: null/array excluded above, typeof "object" confirmed → Record shape
  const obj = parsed as Record<string, unknown>;

  const nodeId = obj.nodeId;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame missing or invalid 'nodeId' (non-empty string required)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const agentId = obj.agentId;
  if (typeof agentId !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame missing or invalid 'agentId' (string required)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const correlationId = obj.correlationId;
  if (typeof correlationId !== "string" || correlationId.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame missing or invalid 'correlationId' (non-empty string required)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const type = obj.type;
  if (typeof type !== "string" || !VALID_FRAME_TYPES.has(type)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Frame has invalid 'type': ${String(type)}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const ttl = obj.ttl;
  if (ttl !== undefined && ttl !== null && (typeof ttl !== "number" || ttl < 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Frame 'ttl' must be a non-negative number or omitted",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const frame: NodeFrame = {
    nodeId,
    agentId,
    correlationId,
    type: type as NodeFrameType,
    payload: obj.payload,
    ...(typeof ttl === "number" ? { ttl } : {}),
  };

  return { ok: true, value: frame };
}

// ---------------------------------------------------------------------------
// Correlation ID generation
// ---------------------------------------------------------------------------

// let: monotonic counter for correlation ID uniqueness across a Node's lifetime
let counter = 0;

/** Generate a unique correlation ID for outbound frames. */
export function generateCorrelationId(nodeId: string): string {
  counter += 1;
  return `${nodeId}-${Date.now()}-${counter}`;
}
