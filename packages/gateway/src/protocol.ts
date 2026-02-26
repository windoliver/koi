/**
 * Wire protocol: parse and encode GatewayFrame.
 */

import type { KoiError, Result } from "@koi/core";
import type { ConnectFrame, GatewayFrame, GatewayFrameKind } from "./types.js";

const VALID_KINDS = new Set<string>(["request", "response", "event", "ack", "error"]);

function makeError<T>(message: string): Result<T, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: false },
  };
}

/**
 * Parse a raw JSON string into a validated GatewayFrame.
 * Rejects early on malformed JSON or missing/invalid fields.
 */
export function parseFrame(raw: string): Result<GatewayFrame, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return makeError("Malformed JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return makeError("Frame must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // kind
  if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) {
    return makeError(`Invalid or missing "kind": expected one of ${[...VALID_KINDS].join(", ")}`);
  }

  // id
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return makeError('Missing or empty "id"');
  }

  // seq
  if (typeof obj.seq !== "number" || !Number.isInteger(obj.seq) || obj.seq < 0) {
    return makeError('"seq" must be a non-negative integer');
  }

  // timestamp
  if (typeof obj.timestamp !== "number") {
    return makeError('"timestamp" must be a number');
  }

  // ref (optional)
  if (obj.ref !== undefined && typeof obj.ref !== "string") {
    return makeError('"ref" must be a string when present');
  }

  const frame: GatewayFrame = {
    kind: obj.kind as GatewayFrameKind,
    id: obj.id as string,
    seq: obj.seq as number,
    timestamp: obj.timestamp as number,
    payload: obj.payload,
    ...(obj.ref !== undefined ? { ref: obj.ref as string } : {}),
  };

  return { ok: true, value: frame };
}

/**
 * Negotiate the highest mutually supported protocol version between client and server.
 * Returns the highest version in the overlap, or an error if no overlap exists.
 */
export function negotiateProtocol(
  clientMin: number,
  clientMax: number,
  serverMin: number,
  serverMax: number,
): Result<number, KoiError> {
  const overlapMin = Math.max(clientMin, serverMin);
  const overlapMax = Math.min(clientMax, serverMax);

  if (overlapMin > overlapMax) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `No protocol overlap: client [${clientMin}..${clientMax}], server [${serverMin}..${serverMax}]`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: overlapMax };
}

/**
 * Parse the first message on a connection as a structured ConnectFrame.
 * Accepts both new range format (minProtocol/maxProtocol) and legacy format (protocol).
 * Rejects if the message is not a valid connect frame.
 */
export function parseConnectFrame(raw: string): Result<ConnectFrame, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return makeError("Malformed JSON in connect frame");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return makeError("Connect frame must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.kind !== "connect") {
    return makeError('First message must be a connect frame (kind: "connect")');
  }

  // Protocol version: accept range format or legacy single-value format
  let minProtocol: number;
  let maxProtocol: number;

  const hasRange = obj.minProtocol !== undefined || obj.maxProtocol !== undefined;
  const hasLegacy = obj.protocol !== undefined;

  if (hasRange) {
    if (
      typeof obj.minProtocol !== "number" ||
      !Number.isInteger(obj.minProtocol) ||
      obj.minProtocol < 1
    ) {
      return makeError('"minProtocol" must be a positive integer');
    }
    if (
      typeof obj.maxProtocol !== "number" ||
      !Number.isInteger(obj.maxProtocol) ||
      obj.maxProtocol < 1
    ) {
      return makeError('"maxProtocol" must be a positive integer');
    }
    if (obj.minProtocol > obj.maxProtocol) {
      return makeError('"minProtocol" must be <= "maxProtocol"');
    }
    minProtocol = obj.minProtocol as number;
    maxProtocol = obj.maxProtocol as number;
  } else if (hasLegacy) {
    if (typeof obj.protocol !== "number" || !Number.isInteger(obj.protocol) || obj.protocol < 1) {
      return makeError('"protocol" must be a positive integer');
    }
    minProtocol = obj.protocol as number;
    maxProtocol = obj.protocol as number;
  } else {
    return makeError('Missing protocol version: provide "minProtocol"/"maxProtocol" or "protocol"');
  }

  if (typeof obj.auth !== "object" || obj.auth === null || Array.isArray(obj.auth)) {
    return makeError('"auth" must be an object');
  }

  const auth = obj.auth as Record<string, unknown>;
  if (typeof auth.token !== "string" || auth.token.length === 0) {
    return makeError('"auth.token" must be a non-empty string');
  }

  // client is optional
  let client: ConnectFrame["client"];
  if (obj.client !== undefined) {
    if (typeof obj.client !== "object" || obj.client === null || Array.isArray(obj.client)) {
      return makeError('"client" must be an object when present');
    }
    const c = obj.client as Record<string, unknown>;
    client = {
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      ...(typeof c.version === "string" ? { version: c.version } : {}),
      ...(typeof c.platform === "string" ? { platform: c.platform } : {}),
    };
  }

  // resume is optional
  let resume: ConnectFrame["resume"];
  if (obj.resume !== undefined) {
    if (typeof obj.resume !== "object" || obj.resume === null || Array.isArray(obj.resume)) {
      return makeError('"resume" must be an object when present');
    }
    const r = obj.resume as Record<string, unknown>;
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0) {
      return makeError('"resume.sessionId" must be a non-empty string');
    }
    if (typeof r.lastSeq !== "number" || !Number.isInteger(r.lastSeq) || r.lastSeq < 0) {
      return makeError('"resume.lastSeq" must be a non-negative integer');
    }
    resume = { sessionId: r.sessionId, lastSeq: r.lastSeq };
  }

  const frame: ConnectFrame = {
    kind: "connect",
    minProtocol,
    maxProtocol,
    auth: { token: auth.token as string },
    ...(client !== undefined ? { client } : {}),
    ...(resume !== undefined ? { resume } : {}),
  };

  return { ok: true, value: frame };
}

/**
 * Encode a GatewayFrame to its JSON wire representation.
 */
export function encodeFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Monotonic frame ID generator (server-side only)
// ---------------------------------------------------------------------------

export type FrameIdGenerator = () => string;

/**
 * Create a monotonic frame ID generator scoped to a single gateway instance.
 * Each call to the returned function produces a unique, sequentially-ordered ID.
 */
export function createFrameIdGenerator(): FrameIdGenerator {
  const instanceId = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  return (): string => `gw-${instanceId}-${counter++}`;
}

// Shared default generator for backward compatibility with bare createErrorFrame/createAckFrame calls
const defaultNextId = createFrameIdGenerator();

/**
 * Create a JSON-encoded error frame string for server-generated error responses.
 */
export function createErrorFrame(
  seq: number,
  code: string,
  message: string,
  nextId: FrameIdGenerator = defaultNextId,
): string {
  return encodeFrame({
    kind: "error",
    id: nextId(),
    seq,
    timestamp: Date.now(),
    payload: { code, message },
  });
}

/**
 * Create a JSON-encoded ack frame string for server-generated acknowledgements.
 */
export function createAckFrame(
  seq: number,
  ref?: string,
  payload?: unknown,
  nextId: FrameIdGenerator = defaultNextId,
): string {
  return encodeFrame({
    kind: "ack",
    id: nextId(),
    seq,
    timestamp: Date.now(),
    payload: payload ?? null,
    ...(ref !== undefined ? { ref } : {}),
  });
}
