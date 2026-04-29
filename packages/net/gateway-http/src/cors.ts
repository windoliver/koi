import type { CorsConfig } from "./types.js";

export function isOriginAllowed(origin: string | null, config: CorsConfig): boolean {
  if (origin === null) return false;
  return config.allowedOrigins.includes(origin);
}

/**
 * Returns a Response if the request is a CORS preflight (OPTIONS).
 * Returns null for non-preflight; caller continues the pipeline.
 */
export function applyCors(req: Request, config: CorsConfig): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("Origin");
  if (origin === null || !isOriginAllowed(origin, config)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": config.allowedMethods.join(", "),
      "Access-Control-Allow-Headers": config.allowedHeaders.join(", "),
      "Access-Control-Max-Age": String(config.maxAgeSeconds),
      Vary: "Origin",
    },
  });
}
