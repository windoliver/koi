/**
 * HTTP utilities for canvas HTTP server.
 *
 * Inlined here (not shared via L0u) because the helpers are tiny, scoped to
 * canvas, and pulling them into a shared utility would couple unrelated
 * gateway packages. KISS — Rule of Three not yet met.
 */

// ---------------------------------------------------------------------------
// JSON response
// ---------------------------------------------------------------------------

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

interface ParsedBody {
  readonly ok: true;
  readonly raw: string;
  readonly parsed: unknown;
}

interface ParseBodyError {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
}

export type ParseBodyResult = ParsedBody | ParseBodyError;

/**
 * Read and parse a JSON request body with streaming size enforcement.
 * Returns the raw string (useful for HMAC verification) and the parsed JSON.
 */
export async function parseJsonBody(request: Request, maxBytes: number): Promise<ParseBodyResult> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > maxBytes) {
    return { ok: false, status: 413, message: "Payload too large" };
  }

  let raw = "";
  try {
    if (request.body !== null) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return { ok: false, status: 413, message: "Payload too large" };
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
  } catch {
    return { ok: false, status: 400, message: "Failed to read request body" };
  }

  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, status: 400, message: "Invalid JSON body" };
    }
  }

  return { ok: true, raw, parsed };
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

interface PathMatch {
  readonly match: true;
  readonly segments: readonly string[];
}

interface PathNoMatch {
  readonly match: false;
}

export type PathMatchResult = PathMatch | PathNoMatch;

/**
 * Match a URL pathname against a prefix with boundary safety.
 *
 * Prevents "/canvas" from matching "/canvasadmin" by requiring an exact match
 * or a "/" boundary after the prefix. Returns segments after the prefix.
 */
export function matchPath(pathname: string, prefix: string): PathMatchResult {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return { match: false };
  }
  const pathAfterPrefix = pathname.slice(prefix.length);
  const segments = pathAfterPrefix.split("/").filter((s) => s.length > 0);
  return { match: true, segments };
}
