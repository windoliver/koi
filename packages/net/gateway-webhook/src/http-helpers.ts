/**
 * HTTP utilities for the webhook server.
 * Inlined here to avoid an L2 peer dependency on @koi/gateway.
 */

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

type ParseBodyResult =
  | { readonly ok: true; readonly raw: string; readonly parsed: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Stream-read and JSON-parse a request body with size enforcement.
 * Returns both the raw string (for HMAC verification) and the parsed value.
 */
export async function parseJsonBody(request: Request, maxBytes: number): Promise<ParseBodyResult> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && parseInt(declaredLength, 10) > maxBytes) {
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
          reader.cancel();
          return { ok: false, status: 413, message: "Payload too large" };
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
  } catch {
    return { ok: false, status: 400, message: "Failed to read request body" };
  }

  if (raw.length === 0) {
    return { ok: true, raw: "", parsed: null };
  }

  try {
    return { ok: true, raw, parsed: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

type PathMatchResult =
  | { readonly match: true; readonly segments: readonly string[] }
  | { readonly match: false };

/**
 * Match a pathname against a prefix with "/" boundary safety.
 * Prevents "/webhook" from matching "/webhookadmin".
 */
export function matchPath(pathname: string, prefix: string): PathMatchResult {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return { match: false };
  }
  const after = pathname.slice(prefix.length);
  const segments = after.split("/").filter((s) => s.length > 0);
  return { match: true, segments };
}
