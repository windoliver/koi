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
 * Parse the first message on a connection as a structured ConnectFrame.
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

  if (obj.type !== "connect") {
    return makeError('First message must be a connect frame (type: "connect")');
  }

  if (typeof obj.protocol !== "number" || !Number.isInteger(obj.protocol) || obj.protocol < 1) {
    return makeError('"protocol" must be a positive integer');
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

  const frame: ConnectFrame = {
    type: "connect",
    protocol: obj.protocol as number,
    auth: { token: auth.token as string },
    ...(client !== undefined ? { client } : {}),
  };

  return { ok: true, value: frame };
}

/**
 * Encode a GatewayFrame to its JSON wire representation.
 */
export function encodeFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame);
}
