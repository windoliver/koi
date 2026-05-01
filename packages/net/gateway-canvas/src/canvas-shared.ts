/**
 * Shared route helpers for `canvas-routes.ts` and `canvas-sse-route.ts`.
 * Internal — not part of the package's public API.
 */

import type { Result } from "@koi/core";

import { jsonResponse } from "./http-helpers.js";
import type { CanvasAuthenticator, CanvasAuthResult } from "./types.js";

export const textEncoder: TextEncoder = new TextEncoder();

/** Surface ID: 1-128 alphanumeric chars, hyphens, underscores. */
const SURFACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidSurfaceId(id: string): boolean {
  return SURFACE_ID_PATTERN.test(id);
}

/** Type guard: value is a non-null, non-array object usable as Record<string, unknown>. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compose a tenant-qualified SSE stream key. The CanvasSseManager registry
 * is keyed by raw string, so without this composition two tenants who own
 * surfaces with the same `surfaceId` (legal under the tenant-scoped store
 * namespace) would share one live event stream — a cross-tenant
 * confidentiality breach. Always pass the qualified key to
 * `sse.subscribe/publish/close/nextEventId`.
 */
export function sseKey(ownerId: string, surfaceId: string): string {
  return `${ownerId}\x00${surfaceId}`;
}

/**
 * Per-server byte budget for pre-start SSE handshake buffers, summed
 * across every concurrent in-flight subscribe on a single
 * `createCanvasServer()` instance. Cap at 64 MiB per server; handshakes
 * that would exceed it are rejected with 503 before reserving an SSE slot.
 * Scoped per-server (not module-global) so one canvas instance cannot
 * starve unrelated instances in the same process.
 */
export const HANDSHAKE_BYTES_CAP_PER_SERVER: number = 64 * 1024 * 1024;

export interface HandshakeBudget {
  bytes: number;
}

/**
 * Distinguish "the caller is unauthorized" from "the auth backend failed."
 * - `unauthorized` → 401 (caller must fix credentials)
 * - `unavailable`  → 503 + Retry-After (backend outage; safe to retry)
 */
export type AuthFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly message: string };

export async function requireAuth(
  request: Request,
  authenticator: CanvasAuthenticator,
): Promise<Result<CanvasAuthResult, AuthFailure>> {
  // let: holds the authenticator's result; reassigned in the catch path below.
  let result: Awaited<ReturnType<CanvasAuthenticator>>;
  try {
    result = await authenticator(request);
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[gateway-canvas] authenticator threw: ${detail}`);
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : "Auth backend threw",
      },
    };
  }
  if (result.ok) {
    // Reject blank/whitespace agentId at the auth boundary.
    if (result.value.agentId.trim() === "") {
      return { ok: false, error: { kind: "unauthorized" } };
    }
    return { ok: true, value: result.value };
  }
  // Retryable error codes from the authenticator indicate backend trouble,
  // not caller misauthentication. Surface as 503.
  const code = result.error.code;
  if (
    code === "EXTERNAL" ||
    code === "TIMEOUT" ||
    code === "UNAVAILABLE" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "RATE_LIMIT" ||
    result.error.retryable === true
  ) {
    return { ok: false, error: { kind: "unavailable", message: result.error.message } };
  }
  return { ok: false, error: { kind: "unauthorized" } };
}

export function authFailureResponse(failure: AuthFailure): Response {
  if (failure.kind === "unavailable") {
    // Generic client-facing message — never echo backend exception text.
    return new Response(JSON.stringify({ ok: false, error: "Auth backend unavailable" }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
        "Cache-Control": "private, no-store",
        Vary: "Authorization",
      },
    });
  }
  return jsonResponse(401, { ok: false, error: "Unauthorized" });
}

function storeUnavailableResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: "Surface store unavailable" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "5",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

/**
 * Bounded 503 for store backend faults. Wrap every `await store.*` so a
 * thrown promise becomes a retryable response instead of an opaque 500.
 */
export async function safeStoreCall<T>(
  call: () => Promise<T> | T,
  context: string,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await call() };
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[gateway-canvas] store backend failed at ${context}: ${detail}`);
    return { ok: false, response: storeUnavailableResponse() };
  }
}

/**
 * Map a structured `Result` error returned by a (durable) SurfaceStore
 * to a transient-503 response when the error code or `retryable` flag
 * indicates a backend problem rather than a client-fault. Returns
 * `undefined` when the error should fall through to route-specific
 * mapping (NOT_FOUND → 404, CONFLICT → 412, PERMISSION → 404, etc.).
 */
export function transientStoreFailureResponse(
  error: {
    readonly code: string;
    readonly retryable?: boolean | undefined;
    readonly message: string;
  },
  context: string,
): Response | undefined {
  const code = error.code;
  const isTransient =
    code === "EXTERNAL" ||
    code === "TIMEOUT" ||
    code === "UNAVAILABLE" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "RATE_LIMIT" ||
    error.retryable === true;
  if (!isTransient) return undefined;
  console.error(
    `[gateway-canvas] store reported transient failure at ${context}: ${code} ${error.message}`,
  );
  return new Response(JSON.stringify({ ok: false, error: "Surface store unavailable" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "5",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}
