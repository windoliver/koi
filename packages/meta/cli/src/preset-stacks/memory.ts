/**
 * Memory preset stack — in-memory memory backend + memory tool provider
 * + extraction middleware.
 *
 * Bundles everything related to "stored learnings" into a single stack:
 *
 *   - A clearable in-memory `MemoryToolBackend` (Map-based, wiped on
 *     `onResetSession`).
 *   - The memory tool provider that exposes memory_store / memory_recall
 *     / memory_search / memory_delete tools to the model.
 *   - The extraction middleware that harvests structured takeaways from
 *     spawn tool outputs and stores them as `MemoryRecord` entries.
 *
 * Exports:
 *   - `memoryBackend` — the clearable backend, so other callers (rewind,
 *     debug inspection) can peek at the records.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord, MemoryRecordInput } from "@koi/core";
import { memoryRecordId } from "@koi/core";
import type { MemoryToolBackend } from "@koi/memory-tools";
import { createMemoryToolProvider } from "@koi/memory-tools";
import { createExtractionMiddleware } from "@koi/middleware-extraction";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

/** In-memory MemoryToolBackend with session-scoped clear(). */
export interface ClearableMemoryBackend extends MemoryToolBackend {
  /** Clear all stored memories — called on session reset. */
  readonly clear: () => void;
}

export const MEMORY_EXPORTS = {
  memoryBackend: "memoryBackend",
} as const;

function createInMemoryMemoryBackend(): ClearableMemoryBackend {
  const records = new Map<string, MemoryRecord>();
  // let: mutable counter for ID generation
  let counter = 0;

  return {
    store: (input: MemoryRecordInput) => {
      counter += 1;
      const id = memoryRecordId(`mem-${counter}`);
      const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
      const now = Date.now();
      const record: MemoryRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
      records.set(id, record);
      return { ok: true as const, value: record };
    },
    storeWithDedup: (input: MemoryRecordInput, opts: { readonly force: boolean }) => {
      const match = [...records.values()].find(
        (r) => r.name === input.name && r.type === input.type,
      );
      if (match !== undefined) {
        if (!opts.force) {
          return { ok: true as const, value: { action: "conflict" as const, existing: match } };
        }
        const updated = {
          ...match,
          description: input.description,
          content: input.content,
          updatedAt: Date.now(),
        } as MemoryRecord;
        records.set(match.id, updated);
        return { ok: true as const, value: { action: "updated" as const, record: updated } };
      }
      counter += 1;
      const id = memoryRecordId(`mem-${counter}`);
      const filePath = `${input.name.toLowerCase().replace(/\s+/g, "_")}.md`;
      const now = Date.now();
      const record: MemoryRecord = { id, ...input, filePath, createdAt: now, updatedAt: now };
      records.set(id, record);
      return { ok: true as const, value: { action: "created" as const, record } };
    },
    recall: (_query, _options) => {
      return { ok: true as const, value: [...records.values()] };
    },
    search: (filter) => {
      const all = [...records.values()];
      const filtered = filter.type !== undefined ? all.filter((r) => r.type === filter.type) : all;
      return { ok: true as const, value: filtered };
    },
    delete: (id) => {
      const wasPresent = records.has(id);
      records.delete(id);
      return { ok: true as const, value: { wasPresent } };
    },
    findByName: (name, type) => {
      const match = [...records.values()].find(
        (r) => r.name === name && (type === undefined || r.type === type),
      );
      return { ok: true as const, value: match };
    },
    get: (id) => {
      return { ok: true as const, value: records.get(id) };
    },
    update: (id, patch) => {
      const existing = records.get(id);
      if (existing === undefined)
        return {
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
        };
      const updated = { ...existing, ...patch, updatedAt: Date.now() } as MemoryRecord;
      records.set(id, updated);
      return { ok: true as const, value: updated };
    },
    clear: () => {
      records.clear();
      counter = 0;
    },
  };
}

export const memoryStack: PresetStack = {
  id: "memory",
  description: "In-memory memory backend + memory tools + spawn extraction middleware",
  activate: (ctx): StackContribution => {
    const memoryBackend = createInMemoryMemoryBackend();
    const memoryDir = join(tmpdir(), `koi-${ctx.hostId}-memory`);
    const memoryProviderResult = createMemoryToolProvider({
      backend: memoryBackend,
      memoryDir,
    });

    const extractionMw = createExtractionMiddleware({
      memory: {
        async recall() {
          const result = await memoryBackend.recall("", undefined);
          if (!result.ok) return [];
          return result.value.map((r: MemoryRecord) => ({
            content: r.content,
            score: 1.0,
            record: r,
          }));
        },
        async store(content: string, options?: { readonly category?: string | undefined }) {
          memoryBackend.store({
            name: `extracted-${Date.now()}`,
            description: options?.category ?? "extracted learning",
            type: "feedback",
            content,
          });
        },
      },
    });

    return {
      middleware: [extractionMw],
      providers: memoryProviderResult.ok ? [memoryProviderResult.value] : [],
      exports: {
        [MEMORY_EXPORTS.memoryBackend]: memoryBackend,
      },
      onResetSession: () => {
        memoryBackend.clear();
      },
    };
  },
};
