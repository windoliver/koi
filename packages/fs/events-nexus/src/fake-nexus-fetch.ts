/**
 * In-memory fake Nexus JSON-RPC server for testing.
 *
 * Implements the Nexus filesystem methods (read, write, exists, delete, glob)
 * with enhanced glob matching that supports multi-level wildcard patterns.
 */

// ---------------------------------------------------------------------------
// JSON-RPC types (local to fake — no shared dependency needed)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match a file path against a glob pattern.
 * Supports `*` (single segment) and `**` is not needed — we use `*` for
 * filename matching within a known directory structure.
 *
 * Pattern: /events/streams/x/events/*.json
 * matches: /events/streams/x/events/0000000001.json
 */
function matchGlob(pattern: string, path: string): boolean {
  // Split pattern and path into segments
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const sp = pathParts[i];
    if (pp === undefined || sp === undefined) return false;
    if (pp === "*") continue;
    if (pp.includes("*")) {
      // Convert glob to regex: *.json → ^.*\.json$
      const regex = new RegExp(`^${pp.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (!regex.test(sp)) return false;
    } else if (pp !== sp) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a fake fetch that mimics a Nexus JSON-RPC server with in-memory storage. */
export function createFakeNexusFetch(): typeof globalThis.fetch {
  const files = new Map<string, string>();

  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as JsonRpcRequest;
    const { method, params, id } = body;

    // let justified: result assigned in switch branches
    let result: unknown;

    switch (method) {
      case "write": {
        const path = params.path as string;
        const content = params.content as string;
        files.set(path, content);
        result = null;
        break;
      }
      case "read": {
        const path = params.path as string;
        const content = files.get(path);
        if (content === undefined) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: "Not found" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        result = content;
        break;
      }
      case "exists": {
        const path = params.path as string;
        result = files.has(path);
        break;
      }
      case "delete": {
        const path = params.path as string;
        files.delete(path);
        result = null;
        break;
      }
      case "glob": {
        const pattern = params.pattern as string;
        const matched: string[] = [];
        for (const key of files.keys()) {
          if (matchGlob(pattern, key)) {
            matched.push(key);
          }
        }
        matched.sort();
        result = matched;
        break;
      }
      default: {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}
