/**
 * CORS middleware — adds cross-origin headers when enabled.
 */

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id",
  "access-control-max-age": "86400",
};

/** Get CORS headers as a plain record. */
export function getCorsHeaders(): Readonly<Record<string, string>> {
  return CORS_HEADERS;
}

/** Apply CORS headers to a response. Returns a new Response. */
export function applyCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Handle CORS preflight (OPTIONS) requests. */
export function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
