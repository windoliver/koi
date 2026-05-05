/**
 * Bearer-token auth check. Constant-time comparison to prevent timing oracles.
 *
 * Returns:
 *   - `"unconfigured"` when the server has no token configured (fail closed).
 *   - `"missing"` when the request lacks a usable bearer header.
 *   - `"invalid"` when the token does not match.
 *   - `"ok"` on success.
 */
export type AuthOutcome = "ok" | "missing" | "invalid" | "unconfigured";

const BEARER_PREFIX = "Bearer ";

export function checkAuth(request: Request, expectedToken: string): AuthOutcome {
  // Defensive: TypeScript declares `expectedToken: string` but JS callers,
  // transpiled code, or `process.env.X` (typed `string | undefined`) can
  // still hand us a non-string at runtime. Treat anything non-stringy or
  // empty as unconfigured so the documented fail-closed 503 is returned
  // instead of a generic catch-all 500.
  if (typeof expectedToken !== "string" || expectedToken.length === 0) {
    return "unconfigured";
  }

  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) return "missing";

  const presented = header.slice(BEARER_PREFIX.length).trim();
  if (presented.length === 0) return "missing";

  return constantTimeEquals(presented, expectedToken) ? "ok" : "invalid";
}

/**
 * Constant-time string comparison. Returns false for length mismatch but
 * still walks the longer string so an attacker cannot infer length via timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const lenA = a.length;
  const lenB = b.length;
  const max = lenA > lenB ? lenA : lenB;
  let diff = lenA ^ lenB;
  for (let i = 0; i < max; i += 1) {
    const ca = i < lenA ? a.charCodeAt(i) : 0;
    const cb = i < lenB ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
