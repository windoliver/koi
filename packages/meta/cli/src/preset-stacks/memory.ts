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
 * Note on `@koi/middleware-collective-memory`: this newer cross-spawn learning
 * middleware operates on `BrickArtifact.collectiveMemory` via a `ForgeStore`,
 * which is a separate persistence layer from `MemoryStore` used here. Wiring it
 * into the CLI preset requires a concrete `ForgeStore` implementation that does
 * not yet exist in this monorepo. When that lands (tracked as a separate piece
 * of infrastructure), pass the resulting forgeStore + a tenant-aware
 * resolveBrickId derived from `ctx.session.{userId,channelId,conversationId}`
 * to `createCollectiveMemoryMiddleware` and append the middleware to the
 * returned `middleware` array below.
 *
 * Exports:
 *   - `memoryDir` — the resolved absolute path to the memory directory,
 *     so other callers (debug inspection) can find persisted memories.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { MemoryRecord, MemoryStoreOptions } from "@koi/core";
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
        async store(content: string, options?: MemoryStoreOptions) {
          // Honored fields from MemoryStoreOptions:
          //   - type: forwarded to MemoryRecordInput.type (default: "feedback")
          // NOT honored by this file-backed adapter:
          //   - namespace, tags, relatedEntities, reinforce, causalParents, supersedes
          //
          // Namespace: this adapter uses a single worktree-wide directory and
          // cannot enforce per-namespace storage or recall isolation. Fail closed
          // when namespace is set — persisting into a shared store without recall
          // isolation would silently cross tenant/agent trust boundaries, which is
          // worse than dropping the write. Wire a namespace-aware MemoryComponent
          // for true tenant/agent isolation.
          if (options?.namespace !== undefined) {
            // Throw so the caller (persistCandidates) observes a failure and does
            // not set stored=true or invalidate hot-memory as if a write succeeded.
            throw new Error(
              `[memory-stack] namespace-aware storage not supported by the file-backed adapter ` +
                `(namespace="${options.namespace}"). ` +
                `Wire a namespace-aware MemoryComponent for tenant/agent isolation.`,
            );
          }

          // Derive a stable name via SHA-256(content + category) so duplicate
          // extractions (regex pass + LLM pass on the same learning) upsert the
          // same record rather than accumulate distinct entries in the store.
          const category = options?.category ?? "general";
          const type = options?.type ?? "feedback";
          const confidence = options?.confidence;
          const hash = createHash("sha256")
            .update(`${content}\x00${category}`)
            .digest("hex")
            .slice(0, 16);
          const name = `extracted-${hash}`;
          // Include a short content excerpt in the description so the relevance
          // selector (which only sees name + description + type) has real semantic
          // signal to distinguish entries. Cap at 80 chars to avoid ballooning
          // selector prompts on long learnings.
          const excerpt = content.slice(0, 80).replace(/\n/g, " ").trim();
          const description = `${type}: ${category} — ${excerpt}`;
          // force: true — overwrite a stale same-name+same-type record on re-extraction.
          const result = await memoryBackend.storeWithDedup(
            {
              name,
              description,
              type,
              content,
              ...(confidence !== undefined ? { confidence } : {}),
            },
            { force: true },
          );
          if (!result.ok) {
            // Throw so persistCandidates observes the failure and does not set
            // stored=true or invalidate hot-memory as if the write succeeded.
            throw new Error(`[memory-stack] extraction store failed: ${result.error.message}`);
          } else if (result.value.action === "corrupted") {
            // Multiple records share the same (name, type) key — store is corrupt.
            // Throw so extraction is not marked successful; operator must repair
            // via delete + rebuildIndex.
            throw new Error(
              `[memory-stack] extraction store corrupted: ${result.value.conflictingIds.length} records share name "${result.value.canonicalName}"`,
            );
          } else if (result.value.action === "conflict") {
            // Jaccard content dedup found a record with similar content but a
            // different type (e.g. stale "reference" from before the heuristic/
            // pattern canonical-type fix). Only migrate when:
            //   1. The record has an extraction-generated name (exact format check)
            //   2. Content is an exact match (not just near-duplicate)
            //   3. The type actually differs (otherwise no-op)
            // The name must match a known auto-generated format, not just any name
            // that starts with "extracted-". Without this, a user who stored a memory
            // via memory_store with name "extracted-foo" could have it silently retyped.
            // Known formats:
            //   new: extracted-{16 lowercase hex chars}  (SHA-256-based, this branch)
            //   old: extracted-{13 digits}-{8 hex chars} (timestamp-based, pre-branch)
            const EXTRACTION_NAME_RE = /^extracted-(?:[0-9a-f]{16}|\d{13}-[0-9a-f]{8})$/;
            const { existing } = result.value;
            // Never migrate across the private/non-private boundary — user-type
            // records are private (not syncable) and must not be silently reclassified
            // into a public type (project/reference/feedback) or vice versa.
            const crossesPrivacyBoundary = existing.type === "user" || type === "user";
            if (
              !crossesPrivacyBoundary &&
              EXTRACTION_NAME_RE.test(existing.name) &&
              existing.content === content &&
              existing.type !== type
            ) {
              const migrated = await memoryBackend.update(existing.id, {
                description,
                type,
                ...(confidence !== undefined ? { confidence } : {}),
              });
              if (!migrated.ok) {
                console.warn(
                  `[memory-stack] extraction type migration failed: ${migrated.error.message}`,
                );
              }
            }
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
