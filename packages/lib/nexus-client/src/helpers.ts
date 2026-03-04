/**
 * Shared CRUD helpers for Nexus JSON-RPC operations.
 *
 * Pure wrappers around NexusClient.rpc() that handle JSON serialization,
 * parse errors, and error normalization. Zero I/O — delegates to the client.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS, validation } from "@koi/core";
import type { NexusClient } from "./types.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Wrap a Nexus error with the standard KoiError shape. */
export function wrapNexusError(code: KoiError["code"], message: string, cause?: unknown): KoiError {
  return { code, message, retryable: RETRYABLE_DEFAULTS[code] ?? false, cause };
}

/**
 * Validate that a string is safe to use as a Nexus path segment.
 * Rejects empty strings, path separators, and traversal sequences.
 */
export function validatePathSegment(segment: string, label: string): Result<void, KoiError> {
  if (segment === "" || segment.includes("/") || segment.includes("\\") || segment.includes("..")) {
    return {
      ok: false,
      error: validation(`${label} contains invalid path characters: ${segment}`),
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON document from Nexus and parse it.
 *
 * The Nexus `read` RPC returns raw string content. This helper handles
 * JSON.parse and wraps parse failures into a KoiError.
 */
export async function readJson<T>(client: NexusClient, path: string): Promise<Result<T, KoiError>> {
  const r = await client.rpc<string>("read", { path });
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.value) as T };
  } catch (e: unknown) {
    return { ok: false, error: wrapNexusError("INTERNAL", `Failed to parse JSON at ${path}`, e) };
  }
}

/**
 * Write a JSON-serializable value to Nexus.
 *
 * Stringifies the data and sends it via the `write` RPC.
 */
export async function writeJson(
  client: NexusClient,
  path: string,
  data: unknown,
): Promise<Result<void, KoiError>> {
  const r = await client.rpc<null>("write", { path, content: JSON.stringify(data) });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}

/**
 * Delete a document from Nexus.
 */
export async function deleteJson(
  client: NexusClient,
  path: string,
): Promise<Result<void, KoiError>> {
  const r = await client.rpc<null>("delete", { path });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}
