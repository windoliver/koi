/**
 * In-memory fake Nexus JSON-RPC server for testing.
 *
 * Implements the Nexus filesystem methods (read, write, exists, delete, glob)
 * and scratchpad RPC methods (scratchpad.write, scratchpad.read, etc.)
 * with glob matching that supports single-segment wildcard patterns.
 *
 * Extracted from @koi/events-nexus for reuse across store and event backends.
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
// Scratchpad store entry (local to fake)
// ---------------------------------------------------------------------------

interface ScratchpadStoreEntry {
  readonly path: string;
  readonly content: string;
  readonly groupId: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly generation: number;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match a file path against a glob pattern.
 * Supports `*` (single segment) within a known directory structure.
 *
 * Pattern: /forge/bricks/*.json
 * matches: /forge/bricks/brick_abc.json
 */
function matchGlob(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const sp = pathParts[i];
    if (pp === undefined || sp === undefined) return false;
    if (pp === "*") continue;
    if (pp.includes("*")) {
      const regex = new RegExp(`^${pp.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (!regex.test(sp)) return false;
    } else if (pp !== sp) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

function jsonRpcOk(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Scratchpad key helper
// ---------------------------------------------------------------------------

function scratchpadKey(groupId: string, path: string): string {
  return `${groupId}:${path}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a fake fetch that mimics a Nexus JSON-RPC server with in-memory storage. */
export function createFakeNexusFetch(): typeof globalThis.fetch {
  const files = new Map<string, string>();
  const scratchpad = new Map<string, ScratchpadStoreEntry>();

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
          return jsonRpcError(id, -32000, "Not found");
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

      // -------------------------------------------------------------------
      // Scratchpad RPC methods
      // -------------------------------------------------------------------

      case "scratchpad.write": {
        const groupId = params.groupId as string;
        const authorId = params.authorId as string;
        const path = params.path as string;
        const content = params.content as string;
        const expectedGeneration = params.expectedGeneration as number | undefined;
        const ttlSeconds = params.ttlSeconds as number | undefined;
        const metadata = params.metadata as Record<string, unknown> | undefined;

        const key = scratchpadKey(groupId, path);
        const existing = scratchpad.get(key);
        const currentGeneration = existing?.generation ?? 0;

        // CAS logic
        if (expectedGeneration === 0 && existing !== undefined) {
          return jsonRpcError(id, -32000, "CONFLICT: path already exists");
        }
        if (
          expectedGeneration !== undefined &&
          expectedGeneration > 0 &&
          expectedGeneration !== currentGeneration
        ) {
          return jsonRpcError(
            id,
            -32000,
            `CONFLICT: expected generation ${String(expectedGeneration)} but current is ${String(currentGeneration)}`,
          );
        }

        const now = new Date().toISOString();
        const nextGeneration = currentGeneration + 1;
        const sizeBytes = new TextEncoder().encode(content).byteLength;

        const entry: ScratchpadStoreEntry = {
          path,
          content,
          groupId,
          authorId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          sizeBytes,
          generation: nextGeneration,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        };
        scratchpad.set(key, entry);

        result = { path, generation: nextGeneration, sizeBytes };
        break;
      }

      case "scratchpad.read": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        const entry = scratchpad.get(key);
        if (entry === undefined) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        result = entry;
        break;
      }

      case "scratchpad.generation": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        const entry = scratchpad.get(key);
        if (entry === undefined) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        result = { generation: entry.generation };
        break;
      }

      case "scratchpad.list": {
        const groupId = params.groupId as string;
        const glob = params.glob as string | undefined;
        const authorId = params.authorId as string | undefined;
        const limit = params.limit as number | undefined;

        const entries: ScratchpadStoreEntry[] = [];
        for (const [key, entry] of scratchpad) {
          // Filter by groupId prefix
          if (!key.startsWith(`${groupId}:`)) continue;

          // Filter by glob pattern against the path
          if (glob !== undefined && !matchGlob(glob, entry.path)) continue;

          // Filter by authorId
          if (authorId !== undefined && entry.authorId !== authorId) continue;

          entries.push(entry);

          // Apply limit
          if (limit !== undefined && entries.length >= limit) break;
        }

        result = { entries };
        break;
      }

      case "scratchpad.delete": {
        const groupId = params.groupId as string;
        const path = params.path as string;
        const key = scratchpadKey(groupId, path);
        if (!scratchpad.has(key)) {
          return jsonRpcError(id, -32000, "NOT_FOUND");
        }
        scratchpad.delete(key);
        result = null;
        break;
      }

      case "scratchpad.provision": {
        // No-op success — provisioning is a no-op in the fake
        result = null;
        break;
      }

      default: {
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
      }
    }

    return jsonRpcOk(id, result);
  }) as typeof globalThis.fetch;
}
