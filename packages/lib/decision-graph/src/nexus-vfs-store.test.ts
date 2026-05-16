import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createNexusVfsDecisionGraphStore } from "./nexus-vfs-store.js";
import type { DecisionGraph } from "./types.js";

interface RecordedCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function createMockTransport(): {
  readonly calls: readonly RecordedCall[];
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
} {
  const files = new Map<string, string>();
  const calls: RecordedCall[] = [];
  return {
    calls,
    async call<T>(method: string, params: Record<string, unknown>): Promise<Result<T, KoiError>> {
      calls.push({ method, params });
      const path = params.path;
      if (method === "write" && typeof path === "string") {
        files.set(path, String(params.content));
        return { ok: true, value: null as T };
      }
      if (method === "read" && typeof path === "string") {
        const content = files.get(path);
        if (content === undefined) {
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: "missing", retryable: false },
          };
        }
        return { ok: true, value: content as T };
      }
      return {
        ok: false,
        error: { code: "EXTERNAL", message: `unsupported ${method}`, retryable: false },
      };
    },
  };
}

function graph(): DecisionGraph {
  return {
    sessionId: "session-a",
    nodes: [
      { id: "a", sessionId: "session-a", kind: "session", label: "a" },
      { id: "b", sessionId: "session-a", kind: "trajectory_step", label: "b" },
    ],
    edges: [{ id: "ab", sessionId: "session-a", kind: "contains", from: "a", to: "b" }],
  };
}

describe("createNexusVfsDecisionGraphStore", () => {
  test("persists graph across fresh store instances", async () => {
    const transport = createMockTransport();
    const first = createNexusVfsDecisionGraphStore({ transport });
    const upserted = await first.upsertGraph(graph());
    expect(upserted.ok).toBe(true);

    const second = createNexusVfsDecisionGraphStore({ transport });
    const neighbors = await second.getNeighbors({
      sessionId: "session-a",
      nodeId: "a",
      direction: "outgoing",
      hops: 1,
    });

    expect(neighbors.ok).toBe(true);
    if (!neighbors.ok) return;
    expect(neighbors.value.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(neighbors.value.edges.map((edge) => edge.id)).toEqual(["ab"]);
  });
});
