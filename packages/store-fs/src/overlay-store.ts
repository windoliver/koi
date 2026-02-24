/**
 * 4-tier overlay ForgeStore — composes N FsForgeStore instances into
 * a single ForgeStore with layered read/write semantics.
 *
 * Tier priority (highest first): agent > shared > extensions > bundled.
 * Reads search all tiers; writes target the first writable tier.
 */

import { join } from "node:path";
import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickUpdate,
  ForgeQuery,
  ForgeScope,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { conflict, notFound, permission, validation } from "@koi/core";
import type { FsForgeStoreExtended } from "./fs-store.js";
import { createFsForgeStore } from "./fs-store.js";
import type { TierDescriptor, TierName } from "./tier.js";
import { isTierWritable, TIER_PRIORITY } from "./tier.js";

// ---------------------------------------------------------------------------
// Config & public interface
// ---------------------------------------------------------------------------

export interface OverlayConfig {
  readonly tiers: readonly TierDescriptor[];
}

export interface OverlayForgeStore extends ForgeStore {
  /**
   * Scope-based promote: maps ForgeScope → filesystem tier.
   * Implements the L0 ForgeStore.promote optional method.
   * Idempotent: same contentHash in target tier is a no-op.
   */
  readonly promote: (id: string, targetScope: ForgeScope) => Promise<Result<void, KoiError>>;
  /** Move a brick between named tiers directly (lower-level than scope-based promote). */
  readonly promoteTier: (id: string, toTier: TierName) => Promise<Result<void, KoiError>>;
  /** Find which tier currently owns a brick. */
  readonly locateTier: (id: string) => Promise<Result<TierName, KoiError>>;
  /** Dispose all underlying tier stores (close watchers, timers, listeners). */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal: tier entry (descriptor + extended store instance)
// ---------------------------------------------------------------------------

interface TierEntry {
  readonly descriptor: TierDescriptor;
  readonly store: FsForgeStoreExtended;
}

// ---------------------------------------------------------------------------
// Scope → Tier mapping
// ---------------------------------------------------------------------------

/**
 * Map ForgeScope to the conventional tier name.
 * Used by promote-by-scope to determine the target filesystem tier.
 */
const SCOPE_TO_TIER: Readonly<Record<ForgeScope, TierName>> = {
  agent: "agent",
  zone: "shared",
  // Global scope uses "shared" tier because "bundled" is read-only at runtime
  global: "shared",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sort tier entries by TIER_PRIORITY order. */
function sortByPriority(entries: readonly TierEntry[]): readonly TierEntry[] {
  const priorityMap = new Map(TIER_PRIORITY.map((name, idx) => [name, idx]));
  return [...entries].sort((a, b) => {
    const pa = priorityMap.get(a.descriptor.name) ?? Number.MAX_SAFE_INTEGER;
    const pb = priorityMap.get(b.descriptor.name) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

/** Find the first writable tier entry, or undefined. */
function firstWritable(entries: readonly TierEntry[]): TierEntry | undefined {
  return entries.find((e) => isTierWritable(e.descriptor));
}

/** Find a tier entry by name. */
function findTier(entries: readonly TierEntry[], name: TierName): TierEntry | undefined {
  return entries.find((e) => e.descriptor.name === name);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an overlay ForgeStore backed by multiple FsForgeStore instances.
 *
 * Each tier descriptor gets its own FsForgeStore. Operations compose
 * across tiers following overlay semantics (highest-priority first).
 */
export async function createOverlayForgeStore(config: OverlayConfig): Promise<OverlayForgeStore> {
  if (config.tiers.length === 0) {
    throw new Error("OverlayConfig requires at least one tier");
  }

  // Initialize all tier stores in parallel
  const tierEntries: TierEntry[] = await Promise.all(
    config.tiers.map(async (descriptor) => {
      const store = await createFsForgeStore({
        baseDir: descriptor.baseDir,
        ...(descriptor.watch === true ? { watch: true } : {}),
      });
      return { descriptor, store };
    }),
  );

  // Sort by priority for consistent iteration
  const sorted = sortByPriority(tierEntries);

  // --- onChange notification -------------------------------------------------
  // Forward onChange from all underlying tier stores into a single listener set.
  const changeListeners = new Set<() => void>();

  const notifyListeners = (): void => {
    for (const listener of changeListeners) {
      listener();
    }
  };

  // Subscribe to each tier store's onChange (if available).
  // Tier stores already debounce, so no additional debounce needed here.
  for (const entry of sorted) {
    if (entry.store.onChange !== undefined) {
      entry.store.onChange(notifyListeners);
    }
  }

  const onChange = (listener: () => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  // -- ForgeStore methods ---------------------------------------------------

  /**
   * Save: writes to the first writable tier (agent by default).
   * Returns PERMISSION error if no writable tier is configured.
   */
  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const writable = firstWritable(sorted);
    if (writable === undefined) {
      return { ok: false, error: permission("No writable tier available for save") };
    }
    return writable.store.save(brick);
  };

  /**
   * Load: searches tiers in priority order, returns first match.
   */
  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    for (const entry of sorted) {
      const result = await entry.store.load(id);
      if (result.ok) {
        return result;
      }
      // Only continue if NOT_FOUND; other errors bubble up
      if (result.error.code !== "NOT_FOUND") {
        return result;
      }
    }
    return { ok: false, error: notFound(id, `Brick not found in any tier: ${id}`) };
  };

  /**
   * Search: two-phase approach for efficiency.
   * Phase 1: query in-memory metadata indexes across all tiers (zero disk I/O).
   * Phase 2: dedup by brick ID (priority wins), apply limit, load only winners.
   */
  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    // Phase 1: metadata-only index scan across all tiers
    const seen = new Set<string>();
    const winners: readonly { readonly entry: TierEntry; readonly meta: BrickArtifactBase }[] =
      sorted.flatMap((entry) => {
        const metas = entry.store.searchIndex(query);
        const unique: { readonly entry: TierEntry; readonly meta: BrickArtifactBase }[] = [];
        for (const meta of metas) {
          if (!seen.has(meta.id)) {
            seen.add(meta.id);
            unique.push({ entry, meta });
          }
        }
        return unique;
      });

    // Apply limit after deduplication
    const limited = query.limit !== undefined ? winners.slice(0, query.limit) : winners;

    // Phase 2: load only the winning bricks from disk
    const loadResults = await Promise.all(
      limited.map(async ({ entry, meta }) => {
        const result = await entry.store.loadFromDisk(meta.id);
        return { id: meta.id, result };
      }),
    );

    // Collect successful loads; skip corrupted entries
    const bricks: BrickArtifact[] = [];
    for (const { result } of loadResults) {
      if (result.ok) {
        bricks.push(result.value);
      }
    }
    return { ok: true, value: bricks };
  };

  /**
   * Remove: only removes from writable tiers.
   * Returns NOT_FOUND if brick only exists in a read-only tier.
   */
  const remove = async (id: string): Promise<Result<void, KoiError>> => {
    for (const entry of sorted) {
      const existsResult = await entry.store.exists(id);
      if (!existsResult.ok) {
        return existsResult;
      }
      if (existsResult.value) {
        if (!isTierWritable(entry.descriptor)) {
          return {
            ok: false,
            error: permission(
              `Cannot remove brick '${id}' from read-only tier '${entry.descriptor.name}'`,
            ),
          };
        }
        return entry.store.remove(id);
      }
    }
    return { ok: false, error: notFound(id, `Brick not found in any tier: ${id}`) };
  };

  /**
   * Update: if brick is in a read-only tier, auto-promotes to the first
   * writable tier before applying the update.
   */
  const update = async (id: string, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    // Find which tier owns the brick
    for (const entry of sorted) {
      const existsResult = await entry.store.exists(id);
      if (!existsResult.ok) {
        return existsResult;
      }
      if (existsResult.value) {
        if (isTierWritable(entry.descriptor)) {
          return entry.store.update(id, updates);
        }
        // Auto-promote: load from read-only tier, apply updates in memory, save once
        const writable = firstWritable(sorted);
        if (writable === undefined) {
          return { ok: false, error: permission("No writable tier available for auto-promote") };
        }
        const loadResult = await entry.store.load(id);
        if (!loadResult.ok) {
          return loadResult;
        }
        // Merge updates in memory to avoid a redundant save→read→save cycle
        const merged: BrickArtifact = {
          ...loadResult.value,
          ...(updates.lifecycle !== undefined ? { lifecycle: updates.lifecycle } : {}),
          ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
          ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
          ...(updates.usageCount !== undefined ? { usageCount: updates.usageCount } : {}),
          ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
        };
        return writable.store.save(merged);
      }
    }
    return { ok: false, error: notFound(id, `Brick not found in any tier: ${id}`) };
  };

  /**
   * Exists: checks all tiers in priority order, returns true on first match.
   */
  const exists = async (id: string): Promise<Result<boolean, KoiError>> => {
    for (const entry of sorted) {
      const result = await entry.store.exists(id);
      if (!result.ok) {
        return result;
      }
      if (result.value) {
        return { ok: true, value: true };
      }
    }
    return { ok: true, value: false };
  };

  // -- Overlay-specific methods ---------------------------------------------

  /**
   * Promote: move a brick from its current tier to a target writable tier.
   * Idempotent: if the brick already exists in the target tier with the same
   * contentHash, this is a no-op. Conflicting contentHash returns CONFLICT.
   */
  const promoteTier = async (id: string, toTier: TierName): Promise<Result<void, KoiError>> => {
    const targetEntry = findTier(sorted, toTier);
    if (targetEntry === undefined) {
      return { ok: false, error: validation(`Unknown target tier: ${toTier}`) };
    }
    if (!isTierWritable(targetEntry.descriptor)) {
      return { ok: false, error: permission(`Target tier '${toTier}' is read-only`) };
    }

    // Find source tier
    for (const entry of sorted) {
      const existsResult = await entry.store.exists(id);
      if (!existsResult.ok) {
        return existsResult;
      }
      if (existsResult.value) {
        if (entry.descriptor.name === toTier) {
          // Already in target tier — idempotent no-op
          return { ok: true, value: undefined };
        }
        // Load from source
        const loadResult = await entry.store.load(id);
        if (!loadResult.ok) {
          return loadResult;
        }
        // Idempotency check: if brick already exists in target, compare contentHash
        const targetExistsResult = await targetEntry.store.exists(id);
        if (targetExistsResult.ok && targetExistsResult.value) {
          const targetLoadResult = await targetEntry.store.load(id);
          if (targetLoadResult.ok) {
            if (targetLoadResult.value.contentHash === loadResult.value.contentHash) {
              // Same content already in target — idempotent no-op, clean up source if writable
              if (isTierWritable(entry.descriptor)) {
                await entry.store.remove(id);
              }
              return { ok: true, value: undefined };
            }
            // Different content — conflict
            return {
              ok: false,
              error: conflict(
                `Brick '${id}' already exists in tier '${toTier}' with different content`,
              ),
            };
          }
        }
        // Save to target
        const saveResult = await targetEntry.store.save(loadResult.value);
        if (!saveResult.ok) {
          return saveResult;
        }
        // Remove from source (only if writable)
        if (isTierWritable(entry.descriptor)) {
          const removeResult = await entry.store.remove(id);
          if (!removeResult.ok) {
            return removeResult;
          }
        }
        return { ok: true, value: undefined };
      }
    }
    return { ok: false, error: notFound(id, `Brick not found in any tier: ${id}`) };
  };

  /**
   * Scope-based promote: maps ForgeScope to the conventional tier and delegates.
   * This implements the optional ForgeStore.promote() for scope-aware promotion.
   */
  const promoteByScope = async (
    id: string,
    targetScope: ForgeScope,
  ): Promise<Result<void, KoiError>> => {
    const targetTier = SCOPE_TO_TIER[targetScope];
    return promoteTier(id, targetTier);
  };

  /**
   * LocateTier: scan tiers in priority order, return first tier containing the brick.
   */
  const locateTier = async (id: string): Promise<Result<TierName, KoiError>> => {
    for (const entry of sorted) {
      const existsResult = await entry.store.exists(id);
      if (!existsResult.ok) {
        return existsResult;
      }
      if (existsResult.value) {
        return { ok: true, value: entry.descriptor.name };
      }
    }
    return { ok: false, error: notFound(id, `Brick not found in any tier: ${id}`) };
  };

  // --- Dispose ---------------------------------------------------------------

  const dispose = (): void => {
    for (const entry of sorted) {
      entry.store.dispose();
    }
    changeListeners.clear();
  };

  return {
    save,
    load,
    search,
    remove,
    update,
    exists,
    promote: promoteByScope,
    promoteTier,
    locateTier,
    onChange,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Convenience: create overlay config from a Koi home directory
// ---------------------------------------------------------------------------

/**
 * Build an OverlayConfig using conventional Koi home directory paths.
 *
 * Layout:
 * ```
 * <homeDir>/agents/<agentName>/bricks   → agent tier (read-write)
 * <homeDir>/shared/bricks               → shared tier (read-write)
 * <homeDir>/extensions/bricks            → extensions tier (read-only)
 * <homeDir>/bundled/bricks               → bundled tier (read-only)
 * ```
 */
export function overlayConfigFromHome(homeDir: string, agentName: string): OverlayConfig {
  return {
    tiers: [
      {
        name: "agent",
        access: "read-write",
        baseDir: join(homeDir, "agents", agentName, "bricks"),
      },
      { name: "shared", access: "read-write", baseDir: join(homeDir, "shared", "bricks") },
      { name: "extensions", access: "read-only", baseDir: join(homeDir, "extensions", "bricks") },
      { name: "bundled", access: "read-only", baseDir: join(homeDir, "bundled", "bricks") },
    ],
  };
}
