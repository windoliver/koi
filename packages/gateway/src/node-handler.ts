/**
 * Node frame types, parsing, and encoding for compute-node connections.
 *
 * All types are local to @koi/gateway — no imports from @koi/node (L2 peer).
 * Nodes use a different wire format (NodeFrame) than clients (GatewayFrame).
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";
import type { AdvertisedTool, CapacityReport } from "./node-registry.js";

// ---------------------------------------------------------------------------
// NodeFrame kinds
// ---------------------------------------------------------------------------

const NODE_FRAME_KINDS = new Set([
  "node:handshake",
  "node:capabilities",
  "node:registered",
  "node:heartbeat",
  "node:capacity",
  "node:error",
  "agent:dispatch",
  "agent:message",
  "agent:status",
  "agent:terminate",
  "tool_call",
  "tool_result",
  "tool_error",
] as const);

export type NodeFrameKind =
  | "node:handshake"
  | "node:capabilities"
  | "node:registered"
  | "node:heartbeat"
  | "node:capacity"
  | "node:error"
  | "agent:dispatch"
  | "agent:message"
  | "agent:status"
  | "agent:terminate"
  | "tool_call"
  | "tool_result"
  | "tool_error";

// ---------------------------------------------------------------------------
// NodeFrame
// ---------------------------------------------------------------------------

export interface NodeFrame {
  readonly nodeId: string;
  readonly agentId: string;
  readonly correlationId: string;
  readonly ttl?: number | undefined;
  readonly kind: NodeFrameKind;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface HandshakePayload {
  readonly nodeId: string;
  readonly version: string;
  readonly capacity: CapacityReport;
}

export interface CapabilitiesPayload {
  readonly nodeType: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
}

// ---------------------------------------------------------------------------
// peekFrameKind — quick JSON parse to extract `kind` for routing
// ---------------------------------------------------------------------------

export function peekFrameKind(data: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    return typeof obj.kind === "string" ? obj.kind : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// parseNodeFrame — full validation
// ---------------------------------------------------------------------------

export function parseNodeFrame(data: string): Result<NodeFrame, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, error: validation("Invalid JSON in node frame") };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: validation("Node frame must be a JSON object") };
  }

  const obj = parsed as Record<string, unknown>;

  const kind = obj.kind;
  if (typeof kind !== "string" || !NODE_FRAME_KINDS.has(kind as NodeFrameKind)) {
    return {
      ok: false,
      error: validation(`Invalid or missing node frame kind: ${String(kind)}`),
    };
  }

  const nodeId = obj.nodeId;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return { ok: false, error: validation("nodeId must be a non-empty string") };
  }

  const correlationId = obj.correlationId;
  if (typeof correlationId !== "string" || correlationId.length === 0) {
    return { ok: false, error: validation("correlationId must be a non-empty string") };
  }

  const agentId = obj.agentId;
  if (typeof agentId !== "string") {
    return { ok: false, error: validation("agentId must be a string") };
  }

  const frame: NodeFrame = {
    kind: kind as NodeFrameKind,
    nodeId,
    agentId,
    correlationId,
    payload: obj.payload ?? null,
    ...(typeof obj.ttl === "number" ? { ttl: obj.ttl } : {}),
  };

  return { ok: true, value: frame };
}

// ---------------------------------------------------------------------------
// Payload validators — runtime checks for untrusted node data
// ---------------------------------------------------------------------------

function isCapacityReport(v: unknown): v is CapacityReport {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.current === "number" && typeof o.max === "number" && typeof o.available === "number"
  );
}

export function validateHandshakePayload(payload: unknown): Result<HandshakePayload, KoiError> {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: validation("Handshake payload must be an object") };
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.nodeId !== "string" || obj.nodeId.length === 0) {
    return { ok: false, error: validation("payload.nodeId must be a non-empty string") };
  }
  if (typeof obj.version !== "string") {
    return { ok: false, error: validation("payload.version must be a string") };
  }
  if (!isCapacityReport(obj.capacity)) {
    return {
      ok: false,
      error: validation("payload.capacity must have current, max, available numbers"),
    };
  }
  return {
    ok: true,
    value: { nodeId: obj.nodeId, version: obj.version, capacity: obj.capacity },
  };
}

export function validateCapabilitiesPayload(
  payload: unknown,
): Result<CapabilitiesPayload, KoiError> {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: validation("Capabilities payload must be an object") };
  }
  const obj = payload as Record<string, unknown>;
  if (obj.nodeType !== "full" && obj.nodeType !== "thin") {
    return { ok: false, error: validation("payload.nodeType must be 'full' or 'thin'") };
  }
  if (!Array.isArray(obj.tools)) {
    return { ok: false, error: validation("payload.tools must be an array") };
  }
  const tools: AdvertisedTool[] = [];
  for (const t of obj.tools) {
    if (typeof t !== "object" || t === null) {
      return { ok: false, error: validation("Each tool must be an object") };
    }
    const tool = t as Record<string, unknown>;
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      return { ok: false, error: validation("Each tool must have a non-empty name") };
    }
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof tool.schema === "object" && tool.schema !== null
        ? { schema: tool.schema as Readonly<Record<string, unknown>> }
        : {}),
    });
  }
  return { ok: true, value: { nodeType: obj.nodeType, tools } };
}

export function validateCapacityPayload(payload: unknown): Result<CapacityReport, KoiError> {
  if (!isCapacityReport(payload)) {
    return {
      ok: false,
      error: validation("Capacity payload must have current, max, available numbers"),
    };
  }
  return { ok: true, value: payload };
}

// ---------------------------------------------------------------------------
// encodeNodeFrame — serialize for sending to a node
// ---------------------------------------------------------------------------

export function encodeNodeFrame(frame: NodeFrame): string {
  return JSON.stringify(frame);
}
