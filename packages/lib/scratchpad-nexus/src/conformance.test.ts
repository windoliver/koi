import type { KoiError, Result } from "@koi/core";
import { agentGroupId, agentId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { describeScratchpadConformance } from "@koi/scratchpad-conformance";
import { createNexusScratchpad } from "./scratchpad.js";

interface StoredEntry {
  readonly path: string;
  readonly content: string;
  readonly generation: number;
  readonly groupId: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

// In-process emulator of the server-side scratchpad RPC handler. Backs the
// same JSON-RPC method names the real Nexus exposes (scratchpad.write/read/
// list/delete) with a Map keyed by `${groupId}:${path}` and CAS semantics
// matching the L0 contract. Lives here (not in @koi/scratchpad-conformance)
// because the RPC shape is a detail of this adapter, not the contract.
function createFakeNexusServerTransport(): NexusTransport {
  const store = new Map<string, StoredEntry>();
  const key = (groupId: string, path: string): string => `${groupId}:${path}`;

  return {
    kind: "http",
    health: async () => ({
      ok: true,
      value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
    call: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      if (method === "scratchpad.write") {
        const groupId = params.groupId as string;
        const authorId = params.authorId as string;
        const path = params.path as string;
        const content = params.content as string;
        const expected = params.expectedGeneration as number | undefined;
        const k = key(groupId, path);
        const existing = store.get(k);
        if (expected === 0 && existing !== undefined) {
          return { ok: false, error: { code: "CONFLICT", message: "exists", retryable: false } };
        }
        if (expected !== undefined && expected > 0) {
          if (existing === undefined || existing.generation !== expected) {
            return { ok: false, error: { code: "CONFLICT", message: "stale", retryable: false } };
          }
        }
        const now = new Date().toISOString();
        const generation = (existing?.generation ?? 0) + 1;
        const entry: StoredEntry = {
          path,
          content,
          generation,
          groupId,
          authorId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          sizeBytes: content.length,
        };
        store.set(k, entry);
        return {
          ok: true,
          value: { path, generation, sizeBytes: entry.sizeBytes } as T,
        };
      }
      if (method === "scratchpad.read") {
        const entry = store.get(key(params.groupId as string, params.path as string));
        if (entry === undefined) {
          return { ok: false, error: { code: "NOT_FOUND", message: "missing", retryable: false } };
        }
        return { ok: true, value: { entry } as T };
      }
      if (method === "scratchpad.list") {
        const groupId = params.groupId as string;
        const entries = [...store.values()]
          .filter((e) => e.groupId === groupId)
          .map(({ content: _content, ...summary }) => summary);
        return { ok: true, value: { entries } as T };
      }
      if (method === "scratchpad.delete") {
        store.delete(key(params.groupId as string, params.path as string));
        return { ok: true, value: { ok: true } as T };
      }
      return {
        ok: false,
        error: { code: "EXTERNAL", message: `unknown method ${method}`, retryable: false },
      };
    },
  };
}

let counter = 0;

describeScratchpadConformance("createNexusScratchpad", async () => {
  // Each test gets a fresh fake server (and thus a fresh group) so state
  // never bleeds across tests. Poll interval kept short so onChange events
  // observe writes within the test's 200ms grace window.
  const transport = createFakeNexusServerTransport();
  return createNexusScratchpad({
    groupId: agentGroupId(`conformance-nexus-${++counter}`),
    authorId: agentId("conformance-author"),
    transport,
    pollIntervalMs: 25,
  });
});
