/**
 * Memory preset stack — file-backed memory storage + tools + recall injection
 * + extraction middleware.
 *
 * Bundles everything related to "stored learnings" into a single stack:
 *
 *   - A file-backed MemoryStore via @koi/memory-fs, adapted to the
 *     MemoryToolBackend interface consumed by memory tools.
 *   - The memory tool provider that exposes memory_store / memory_recall
 *     / memory_search / memory_delete tools to the model (with
 *     SkillComponent behavioral guidance).
 *   - The recall middleware that injects a frozen snapshot of recalled
 *     memories at session start (scan → score → budget → format).
 *   - The extraction middleware that harvests structured takeaways from
 *     spawn tool outputs and stores them as MemoryRecord entries.
 *
 * Exports:
 *   - `memoryDir` — the resolved absolute path to the memory directory,
 *     so other callers (debug inspection) can find persisted memories.
 */

import { mkdir } from "node:fs/promises";
import type { MemoryRecord } from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import { createMemoryStore, resolveMemoryDir } from "@koi/memory-fs";
import { createMemoryToolProvider } from "@koi/memory-tools";
import { createExtractionMiddleware } from "@koi/middleware-extraction";
import { createMemoryRecallMiddleware } from "@koi/middleware-memory-recall";
import type { PresetStack, StackContribution } from "../preset-stacks.js";
import { createMemoryToolBackendFromStore } from "./memory-adapter.js";

export const MEMORY_EXPORTS = {
  memoryDir: "memoryDir",
} as const;

export const memoryStack: PresetStack = {
  id: "memory",
  description: "File-backed memory store + tools + recall injection + extraction middleware",
  activate: async (ctx): Promise<StackContribution> => {
    // Resolve the memory directory for this worktree
    const resolved = await resolveMemoryDir(ctx.cwd);
    const memoryDir = resolved.dir;

    // Ensure directory exists before creating backends
    await mkdir(memoryDir, { recursive: true });

    // File-backed store: each memory is a .md file with frontmatter
    const store = createMemoryStore({ dir: memoryDir });

    // Adapt MemoryStore → MemoryToolBackend for the tool provider
    const memoryBackend = createMemoryToolBackendFromStore(store);

    // Memory tool provider (store/recall/search/delete + SkillComponent guidance)
    const memoryProviderResult = createMemoryToolProvider({
      backend: memoryBackend,
      memoryDir,
    });

    if (!memoryProviderResult.ok) {
      console.warn(
        `[memory-stack] memory tool provider failed to build: ${memoryProviderResult.error.message}`,
      );
    }

    // FileSystemBackend for the recall middleware (reads .md files from disk)
    const memoryFs = createLocalFileSystem(memoryDir);

    // Frozen-snapshot recall middleware: scans memory dir once per session,
    // injects formatted memories into every model call. When a model adapter
    // is available, enables per-turn relevance selection (lightweight side-query
    // picks the most relevant memories for the current user message).
    const recallMw = createMemoryRecallMiddleware({
      fs: memoryFs,
      recall: { memoryDir },
      ...(ctx.modelAdapter !== undefined
        ? {
            relevanceSelector: {
              modelCall: ctx.modelAdapter.complete,
              maxFiles: 5,
            },
          }
        : {}),
    });

    // Extraction middleware: harvests learnings from spawn tool outputs
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
          // Make the generated name collision-resistant. `Date.now()`
          // alone is millisecond-granular, so two concurrent extractions
          // landing in the same tick would collide on (name, type) and
          // the atomic upsert path would reject the second one. Append
          // a short random suffix so concurrent extractions always get
          // unique names.
          const suffix = crypto.randomUUID().slice(0, 8);
          const result = await memoryBackend.store({
            name: `extracted-${Date.now()}-${suffix}`,
            description: options?.category ?? "extracted learning",
            type: "feedback",
            content,
          });
          if (!result.ok) {
            console.warn(`[memory-stack] extraction store failed: ${result.error.message}`);
          }
        },
      },
    });

    return {
      middleware: [recallMw, extractionMw],
      providers: memoryProviderResult.ok ? [memoryProviderResult.value] : [],
      exports: {
        [MEMORY_EXPORTS.memoryDir]: memoryDir,
      },
      // No onResetSession — persisted memories survive session resets.
      // The recall middleware resets its frozen cache via onSessionStart.
    };
  },
};
