import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Opaque cursor payload — kept tiny on purpose. */
export interface Cursor {
  readonly lastId: string;
  readonly lastTimestampMs: number;
}

/** Encode a cursor as URL-safe base64. Never throws. */
export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ i: cursor.lastId, t: cursor.lastTimestampMs });
  return base64UrlEncode(json);
}

/**
 * Decode a base64-encoded cursor. Returns a typed `Result` so callers can
 * surface a `VALIDATION` error to the client without throwing.
 */
export function decodeCursor(encoded: string): Result<Cursor, KoiError> {
  try {
    const json = base64UrlDecode(encoded);
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { i?: unknown }).i === "string" &&
      typeof (parsed as { t?: unknown }).t === "number"
    ) {
      const obj = parsed as { i: string; t: number };
      return { ok: true, value: { lastId: obj.i, lastTimestampMs: obj.t } };
    }
    return cursorError("malformed cursor payload");
  } catch (e: unknown) {
    return cursorError("cursor is not valid base64-encoded JSON", e);
  }
}

function cursorError(message: string, cause?: unknown): Result<Cursor, KoiError> {
  const error: KoiError = {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    ...(cause === undefined ? {} : { cause }),
  };
  return { ok: false, error };
}

/** Clamp limit into `[1, max]` with `fallback` when undefined or invalid. */
export function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > max ? max : parsed;
}

function base64UrlEncode(value: string): string {
  // Bun has globalThis.btoa; UTF-8-safe path via TextEncoder.
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
