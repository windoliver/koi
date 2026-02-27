/**
 * Lightweight HTTP client for Gateway canvas CRUD routes.
 *
 * Uses native fetch + AbortSignal.timeout() — no external dependencies.
 * All operations return Result<T, KoiError> for typed error handling.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GatewayClientConfig {
  /** Base URL for the canvas API, e.g. "http://localhost:3000/gateway/canvas". */
  readonly canvasBaseUrl: string;
  /** Optional auth token sent as Bearer in Authorization header. */
  readonly authToken?: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number;
}

/** Result of a successful create/update operation. */
export interface SurfaceResult {
  readonly surfaceId: string;
}

export interface GatewayClient {
  readonly createSurface: (
    surfaceId: string,
    content: string,
  ) => Promise<Result<SurfaceResult, KoiError>>;
  readonly updateSurface: (
    surfaceId: string,
    content: string,
  ) => Promise<Result<SurfaceResult, KoiError>>;
  readonly deleteSurface: (surfaceId: string) => Promise<Result<boolean, KoiError>>;
  readonly computeSurfaceUrl: (surfaceId: string) => string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(authToken: string | undefined): Readonly<Record<string, string>> {
  return authToken !== undefined
    ? { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` }
    : { "Content-Type": "application/json" };
}

function mapHttpError(status: number, body: string, context: string): KoiError {
  if (status === 404) {
    return { code: "NOT_FOUND", message: `${context}: surface not found`, retryable: false };
  }
  if (status === 409) {
    return { code: "CONFLICT", message: `${context}: surface already exists`, retryable: false };
  }
  if (status === 401 || status === 403) {
    return { code: "PERMISSION", message: `${context}: unauthorized`, retryable: false };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `${context}: server error (${status}): ${body}`,
      retryable: true,
    };
  }
  return {
    code: "EXTERNAL",
    message: `${context}: unexpected status ${status}: ${body}`,
    retryable: false,
  };
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("abort") || msg.includes("timeout");
  }
  return false;
}

function mapNetworkError(err: unknown, context: string): KoiError {
  if (isTimeoutError(err)) {
    return { code: "TIMEOUT", message: `${context}: request timed out`, retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "EXTERNAL", message: `${context}: network error — ${message}`, retryable: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates a Gateway canvas HTTP client. */
export function createGatewayClient(config: GatewayClientConfig): GatewayClient {
  const baseUrl = config.canvasBaseUrl.endsWith("/")
    ? config.canvasBaseUrl.slice(0, -1)
    : config.canvasBaseUrl;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    method: string,
    surfaceId: string,
    body: Readonly<Record<string, string>> | undefined,
    context: string,
  ): Promise<Result<{ readonly status: number; readonly text: string }, KoiError>> {
    try {
      const response = await fetch(`${baseUrl}/${surfaceId}`, {
        method,
        headers: makeHeaders(config.authToken),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      return { ok: true, value: { status: response.status, text } };
    } catch (err: unknown) {
      return { ok: false, error: mapNetworkError(err, context) };
    }
  }

  return {
    async createSurface(
      surfaceId: string,
      content: string,
    ): Promise<Result<SurfaceResult, KoiError>> {
      const result = await request("POST", surfaceId, { content }, "createSurface");
      if (!result.ok) return result;

      const { status, text } = result.value;
      if (status === 201) return { ok: true, value: { surfaceId } };
      return { ok: false, error: mapHttpError(status, text, "createSurface") };
    },

    async updateSurface(
      surfaceId: string,
      content: string,
    ): Promise<Result<SurfaceResult, KoiError>> {
      const result = await request("PATCH", surfaceId, { content }, "updateSurface");
      if (!result.ok) return result;

      const { status, text } = result.value;
      if (status === 200) return { ok: true, value: { surfaceId } };
      return { ok: false, error: mapHttpError(status, text, "updateSurface") };
    },

    async deleteSurface(surfaceId: string): Promise<Result<boolean, KoiError>> {
      const result = await request("DELETE", surfaceId, undefined, "deleteSurface");
      if (!result.ok) return result;

      const { status, text } = result.value;
      if (status === 204) return { ok: true, value: true };
      // 404 on delete is idempotent — treat as success
      if (status === 404) return { ok: true, value: false };
      return { ok: false, error: mapHttpError(status, text, "deleteSurface") };
    },

    computeSurfaceUrl(surfaceId: string): string {
      return `${baseUrl}/${surfaceId}`;
    },
  };
}
