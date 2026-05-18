import type { AdvertisedTool, CapacityReport, KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";

const NODE_FRAME_KINDS = new Set([
  "node:handshake",
  "node:capabilities",
  "node:capabilities_query",
  "node:registered",
  "node:heartbeat",
  "node:capacity",
  "node:tools_updated",
  "node:error",
] as const);

export type NodeFrameKind =
  | "node:handshake"
  | "node:capabilities"
  | "node:capabilities_query"
  | "node:registered"
  | "node:heartbeat"
  | "node:capacity"
  | "node:tools_updated"
  | "node:error";

export interface NodeFrame {
  readonly kind: NodeFrameKind;
  readonly nodeId: string;
  readonly agentId: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

export interface NodeHandshakePayload {
  readonly nodeId: string;
  readonly version: string;
  readonly capacity: CapacityReport;
}

export interface NodeCapabilitiesPayload {
  readonly nodeType: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
}

export interface NodeToolsUpdatedPayload {
  readonly added: readonly AdvertisedTool[];
  readonly removed: readonly string[];
}

export function peekNodeFrameKind(data: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    return typeof obj.kind === "string" ? obj.kind : undefined;
  } catch {
    return undefined;
  }
}

export function encodeNodeFrame(frame: NodeFrame): string {
  return JSON.stringify(frame);
}

export function parseNodeFrame(data: string): Result<NodeFrame, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, error: validation("Invalid JSON in node frame") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: validation("Node frame must be an object") };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !NODE_FRAME_KINDS.has(obj.kind as NodeFrameKind)) {
    return { ok: false, error: validation(`Invalid node frame kind: ${String(obj.kind)}`) };
  }
  if (typeof obj.nodeId !== "string" || obj.nodeId.length === 0) {
    return { ok: false, error: validation("nodeId must be a non-empty string") };
  }
  if (typeof obj.agentId !== "string") {
    return { ok: false, error: validation("agentId must be a string") };
  }
  if (typeof obj.correlationId !== "string" || obj.correlationId.length === 0) {
    return { ok: false, error: validation("correlationId must be a non-empty string") };
  }
  return {
    ok: true,
    value: {
      kind: obj.kind as NodeFrameKind,
      nodeId: obj.nodeId,
      agentId: obj.agentId,
      correlationId: obj.correlationId,
      payload: obj.payload ?? null,
    },
  };
}

function isCapacityReport(value: unknown): value is CapacityReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.current === "number" &&
    typeof obj.max === "number" &&
    typeof obj.available === "number"
  );
}

function parseTools(value: unknown): Result<readonly AdvertisedTool[], KoiError> {
  if (!Array.isArray(value)) return { ok: false, error: validation("tools must be an array") };
  const parsed = value.reduce<Result<readonly AdvertisedTool[], KoiError>>(
    (result, entry) => {
      if (!result.ok) return result;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return { ok: false, error: validation("Each advertised tool must be an object") };
      }
      const obj = entry as Record<string, unknown>;
      if (typeof obj.name !== "string" || obj.name.length === 0) {
        return { ok: false, error: validation("Each advertised tool needs a non-empty name") };
      }
      const tool: AdvertisedTool = {
        name: obj.name,
        ...(typeof obj.description === "string" ? { description: obj.description } : {}),
        ...(typeof obj.schema === "object" && obj.schema !== null && !Array.isArray(obj.schema)
          ? { schema: obj.schema as Readonly<Record<string, unknown>> }
          : {}),
      };
      return { ok: true, value: [...result.value, tool] };
    },
    { ok: true, value: [] },
  );
  return parsed;
}

export function validateNodeHandshakePayload(
  payload: unknown,
): Result<NodeHandshakePayload, KoiError> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
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
    return { ok: false, error: validation("payload.capacity must be a CapacityReport") };
  }
  return { ok: true, value: { nodeId: obj.nodeId, version: obj.version, capacity: obj.capacity } };
}

export function validateNodeCapabilitiesPayload(
  payload: unknown,
): Result<NodeCapabilitiesPayload, KoiError> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: validation("Capabilities payload must be an object") };
  }
  const obj = payload as Record<string, unknown>;
  if (obj.nodeType !== "full" && obj.nodeType !== "thin") {
    return { ok: false, error: validation("payload.nodeType must be 'full' or 'thin'") };
  }
  const toolsResult = parseTools(obj.tools);
  if (!toolsResult.ok) return toolsResult;
  return { ok: true, value: { nodeType: obj.nodeType, tools: toolsResult.value } };
}

export function validateNodeToolsUpdatedPayload(
  payload: unknown,
): Result<NodeToolsUpdatedPayload, KoiError> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: validation("Tools update payload must be an object") };
  }
  const obj = payload as Record<string, unknown>;
  const addedResult = parseTools(obj.added);
  if (!addedResult.ok) return addedResult;
  if (!Array.isArray(obj.removed)) {
    return { ok: false, error: validation("removed must be an array") };
  }
  const removed = obj.removed.filter((name): name is string => typeof name === "string");
  if (removed.length !== obj.removed.length) {
    return { ok: false, error: validation("removed entries must be strings") };
  }
  return { ok: true, value: { added: addedResult.value, removed } };
}
