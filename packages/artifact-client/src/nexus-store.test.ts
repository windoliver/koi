/**
 * NexusArtifactStore unit tests with a mocked fetch.
 *
 * Implements a fake Nexus JSON-RPC server that stores data in-memory,
 * allowing the full contract suite to run without a real Nexus instance.
 */

import { describe } from "bun:test";
import { runArtifactStoreContractTests } from "./__tests__/store-contract.js";
import { createNexusArtifactStore } from "./nexus-store.js";

// ---------------------------------------------------------------------------
// Fake Nexus RPC handler
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createFakeNexusFetch(): typeof globalThis.fetch {
  const files = new Map<string, string>();

  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as JsonRpcRequest;
    const { method, params, id } = body;

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
            JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Not found" } }),
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
        // Simple glob: match basePath/*.json
        const prefix = pattern.replace("*.json", "");
        const matched: string[] = [];
        for (const key of files.keys()) {
          if (key.startsWith(prefix) && key.endsWith(".json")) {
            matched.push(key);
          }
        }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusArtifactStore", () => {
  runArtifactStoreContractTests(() =>
    createNexusArtifactStore({
      baseUrl: "http://fake-nexus:2026",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    }),
  );
});
