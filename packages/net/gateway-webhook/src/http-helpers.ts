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
  | {
      readonly ok: true;
      readonly raw: string;
      readonly rawBytes: Uint8Array;
      readonly parsed: unknown;
    }
  | { readonly ok: false; readonly status: number; readonly message: string };

type ReadBodyResult =
  | { readonly ok: true; readonly chunks: Uint8Array[]; readonly totalBytes: number }
  | { readonly ok: false; readonly status: number; readonly message: string };

async function readRequestBody(request: Request, maxBytes: number): Promise<ReadBodyResult> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (request.body !== null) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          reader.cancel();
          return { ok: false, status: 413, message: "Payload too large" };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, status: 400, message: "Failed to read request body" };
  }
  return { ok: true, chunks, totalBytes };
}

/**
 * Stream-read a request body with size enforcement, then try to JSON-parse it.
 * Returns the raw bytes (for byte-exact HMAC verification), the decoded string
 * (for JSON parsing and dedup key extraction), and the parsed JSON value.
 * Non-JSON bodies succeed with `parsed` set to the raw string.
 *
 * Body bytes are collected before decoding to ensure the HMAC is computed
 * over the exact wire bytes, not over a re-encoded text round-trip.
 */
export async function parseJsonBody(request: Request, maxBytes: number): Promise<ParseBodyResult> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && parseInt(declaredLength, 10) > maxBytes) {
    return { ok: false, status: 413, message: "Payload too large" };
  }

  const body = await readRequestBody(request, maxBytes);
  if (!body.ok) return body;

  // Concatenate all chunks into a single buffer, then release chunk refs before
  // decoding so chunk memory can be GC'd while the decoded string is built.
  // This preserves exact wire bytes for HMAC and avoids multi-byte sequence
  // corruption that can occur when decoding in streaming mode across chunks.
  const rawBytes = new Uint8Array(body.totalBytes);
  let offset = 0;
  for (const chunk of body.chunks) {
    rawBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  body.chunks.length = 0; // release chunk refs — rawBytes is now the single source
  const raw = new TextDecoder().decode(rawBytes);

  if (raw.length === 0) {
    return { ok: true, raw: "", rawBytes, parsed: null };
  }

  try {
    return { ok: true, raw, rawBytes, parsed: JSON.parse(raw) };
  } catch {
    // Non-JSON body (e.g. Slack slash commands use form-encoded bodies).
    // Dispatch the raw string as payload; providers handle interpretation.
    return { ok: true, raw, rawBytes, parsed: raw };
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
