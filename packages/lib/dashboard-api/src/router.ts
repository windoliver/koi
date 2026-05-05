/**
 * Tiny path-pattern matcher. Patterns use `:name` for parameters; everything
 * else is matched literally. No optional segments, no wildcards — KISS.
 *
 * Examples:
 *   "/agents"          → matches "/agents"
 *   "/agents/:id"      → matches "/agents/abc", captures { id: "abc" }
 *   "/traces/:id"      → matches "/traces/turn-1", captures { id: "turn-1" }
 */
export interface RouteMatch {
  readonly params: Readonly<Record<string, string>>;
}

export function matchRoute(pattern: string, pathname: string): RouteMatch | undefined {
  const patternParts = splitPath(pattern);
  const actualParts = splitPath(pathname);
  if (patternParts.length !== actualParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i] ?? "";
    const a = actualParts[i] ?? "";
    if (p.startsWith(":")) {
      if (a.length === 0) return undefined;
      const decoded = safeDecode(a);
      if (decoded === undefined) return undefined;
      params[p.slice(1)] = decoded;
    } else if (p !== a) {
      return undefined;
    }
  }
  return { params };
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding (e.g. "/foo/%E0%A4") — treat as non-match so
    // the router emits a 404 instead of leaking URIError as a 500.
    return undefined;
  }
}

function splitPath(p: string): readonly string[] {
  // Strip leading/trailing slashes, then split. Empty path → single empty segment.
  const trimmed = p.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? [""] : trimmed.split("/");
}
