/**
 * ForgeRuntime factory — creates a live forge runtime backed by a ForgeStore.
 *
 * Enables hot-attach: forged tools become available mid-session without
 * requiring agent re-assembly. Caches name→ToolArtifact for O(1) lookups,
 * invalidated on store onChange.
 */

import type {
  BrickArtifact,
  BrickComponentMap,
  BrickKind,
  ForgeStore,
  SigningBackend,
  StoreChangeEvent,
  Tool,
  ToolArtifact,
  ToolDescriptor,
} from "@koi/core";
import type { AttestationCache } from "./attestation-cache.js";
import { createAttestationCache } from "./attestation-cache.js";
import { brickToTool } from "./brick-conversion.js";
import { createDeltaInvalidator, mapBrickToComponent } from "./brick-resolver.js";
import type { DependencyConfig } from "./config.js";
import { createDefaultForgeConfig } from "./config.js";
import { auditDependencies } from "./dependency-audit.js";
import { DEFAULT_SANDBOX_TIMEOUT_MS, MAX_EXTERNAL_LISTENERS } from "./forge-defaults.js";
import { verifyBrickAttestation, verifyBrickIntegrity } from "./integrity.js";
import { checkBrickRequires } from "./requires-check.js";
import type { SandboxExecutor } from "./types.js";
import { createBrickWorkspace, writeBrickEntry } from "./workspace-manager.js";

// Re-use the ForgeRuntime interface from L1 types.
// Import it as a type-only import to avoid L2→L1 dependency.
// The factory returns a structurally compatible object.

export interface CreateForgeRuntimeOptions {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly sandboxTimeoutMs?: number;
  /** When provided, verifies attestation signatures on tool load. */
  readonly signer?: SigningBackend;
  /** Dependency policy for bricks with npm packages. Defaults to ForgeConfig defaults. */
  readonly dependencyConfig?: DependencyConfig;
}

/**
 * ForgeRuntime shape — structurally matches the L1 ForgeRuntime interface.
 * Declared locally to avoid importing from @koi/engine (L2 must not import L1).
 */
export interface ForgeRuntimeInstance {
  readonly resolveTool: (toolId: string) => Promise<Tool | undefined>;
  readonly toolDescriptors: () => Promise<readonly ToolDescriptor[]>;
  readonly watch?: (listener: (event: StoreChangeEvent) => void) => () => void;
  /** Generic per-kind resolution. */
  readonly resolve?: <K extends BrickKind>(
    kind: K,
    name: string,
  ) => Promise<BrickComponentMap[K] | undefined>;
  /** Clean up internal store subscription and external listeners. */
  readonly dispose?: () => void;
}

/**
 * Creates a ForgeRuntime backed by a ForgeStore.
 *
 * - Caches active tool artifacts in a name→ToolArtifact Map
 * - Invalidates cache on store.watch notifications
 * - Provides onChange pass-through from the underlying store
 */
export function createForgeRuntime(options: CreateForgeRuntimeOptions): ForgeRuntimeInstance {
  const {
    store,
    executor,
    sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    signer,
    dependencyConfig = createDefaultForgeConfig().dependencies,
  } = options;

  // let justified: mutable cache invalidated by store.watch
  let cachedTools: ReadonlyMap<string, ToolArtifact> | undefined;
  const integrityCache: AttestationCache = createAttestationCache();

  async function ensureCache(): Promise<ReadonlyMap<string, ToolArtifact>> {
    if (cachedTools !== undefined) {
      return cachedTools;
    }

    const result = await store.search({ kind: "tool", lifecycle: "active" });
    if (!result.ok) {
      // Graceful degradation: return empty map on search failure
      return new Map();
    }

    const tools = new Map<string, ToolArtifact>();
    for (const brick of result.value) {
      if (brick.kind === "tool") {
        tools.set(brick.name, brick);
      }
    }
    cachedTools = tools;
    return cachedTools;
  }

  // Lazy per-kind caches (populated on first resolve for each kind)
  const kindCaches = new Map<BrickKind, ReadonlyMap<string, BrickArtifact>>();

  async function ensureKindCache(kind: BrickKind): Promise<ReadonlyMap<string, BrickArtifact>> {
    const existing = kindCaches.get(kind);
    if (existing !== undefined) return existing;

    const result = await store.search({ kind, lifecycle: "active" });
    if (!result.ok) return new Map();

    const cache = new Map<string, BrickArtifact>();
    for (const brick of result.value) {
      cache.set(brick.name, brick);
    }
    kindCaches.set(kind, cache);
    return cache;
  }

  const deltaInvalidator = createDeltaInvalidator<BrickArtifact>();

  function invalidateCache(): void {
    cachedTools = undefined;
    kindCaches.clear();
    integrityCache.clear();
  }

  /** Delta invalidation: remove a specific brick by ID from all caches. */
  function invalidateByBrickId(brickId: string): void {
    if (cachedTools !== undefined) {
      const toolsMap = new Map(cachedTools);
      deltaInvalidator.invalidateByBrickId(brickId as BrickArtifact["id"], toolsMap);
      cachedTools = toolsMap;
    }
    for (const [kind, cache] of kindCaches) {
      const mutableCache = new Map(cache);
      if (deltaInvalidator.invalidateByBrickId(brickId as BrickArtifact["id"], mutableCache)) {
        kindCaches.set(kind, mutableCache);
      }
    }
    integrityCache.invalidate(brickId);
  }

  /**
   * Resolve a tool artifact by name.
   * Fast path: if cache is cold, try direct store search to avoid loading all tools.
   */
  async function resolveToolArtifact(toolId: string): Promise<ToolArtifact | undefined> {
    // Warm cache: direct lookup
    if (cachedTools !== undefined) {
      return cachedTools.get(toolId);
    }

    // Cold cache fast path: single-brick search by name
    const searchResult = await store.search({
      kind: "tool",
      lifecycle: "active",
      text: toolId,
      limit: 1,
    });
    if (searchResult.ok) {
      const match = searchResult.value[0];
      if (match !== undefined && match.kind === "tool" && match.name === toolId) {
        return match;
      }
    }

    // Fall back to full cache population
    const tools = await ensureCache();
    return tools.get(toolId);
  }

  const resolveTool = async (toolId: string): Promise<Tool | undefined> => {
    // Fast path: if cache is cold, try single-brick lookup before populating full cache
    const artifact = await resolveToolArtifact(toolId);
    if (artifact === undefined) {
      return undefined;
    }

    // On-load integrity verification (cached by content-addressed id)
    const cached = integrityCache.get(artifact.id);
    if (cached !== undefined) {
      if (!cached.valid) {
        return undefined;
      }
    } else {
      // Verify integrity: content-addressed ID + attestation signature (if signer provided)
      const integrityResult =
        signer !== undefined
          ? await verifyBrickAttestation(artifact, signer)
          : verifyBrickIntegrity(artifact);

      integrityCache.set(artifact.id, integrityResult.ok);
      if (!integrityResult.ok) {
        return undefined;
      }
    }

    // Resolve workspace for bricks with npm dependencies
    const packages = artifact.requires?.packages;
    if (packages !== undefined && Object.keys(packages).length > 0) {
      // Pre-install audit: validate package names, versions, allow/blocklist
      const auditResult = auditDependencies(packages, dependencyConfig);
      if (!auditResult.ok) {
        return undefined;
      }

      // Create workspace: installs deps, audits transitives, scans code, verifies integrity
      const wsResult = await createBrickWorkspace(packages, dependencyConfig);
      if (!wsResult.ok) {
        return undefined;
      }

      // Write the brick implementation as a .ts entry file in the workspace
      const entryPath = await writeBrickEntry(
        wsResult.value.workspacePath,
        artifact.implementation,
        artifact.name,
      );

      return brickToTool(
        artifact,
        executor,
        sandboxTimeoutMs,
        wsResult.value.workspacePath,
        entryPath,
      );
    }

    return brickToTool(artifact, executor, sandboxTimeoutMs);
  };

  const toolDescriptors = async (): Promise<readonly ToolDescriptor[]> => {
    const tools = await ensureCache();
    const descriptors: ToolDescriptor[] = [];
    for (const artifact of tools.values()) {
      descriptors.push({
        name: artifact.name,
        description: artifact.description,
        inputSchema: artifact.inputSchema,
      });
    }
    return descriptors;
  };

  /**
   * Generic per-kind resolution. For tools, delegates to resolveTool (integrity checks).
   * For other kinds, uses lazy per-kind caches and wraps artifacts into ECS component types.
   *
   * Justified `as BrickComponentMap[K]` casts: TypeScript cannot prove that when
   * artifact.kind === "skill", the generic K is narrowed to "skill". Each branch
   * is individually type-safe (satisfies ensures correct shape).
   */
  const resolve = async <K extends BrickKind>(
    kind: K,
    name: string,
  ): Promise<BrickComponentMap[K] | undefined> => {
    // For tools, delegate to existing resolveTool (has integrity checks)
    if (kind === "tool") {
      return resolveTool(name) as Promise<BrickComponentMap[K] | undefined>;
    }

    const cache = await ensureKindCache(kind);
    const artifact = cache.get(name);
    if (artifact === undefined) return undefined;

    // Runtime requires enforcement (bins, env, tools) — mirrors ForgeComponentProvider
    const toolNames = await ensureCache();
    const requiresResult = checkBrickRequires(artifact.requires, new Set(toolNames.keys()));
    if (!requiresResult.satisfied) return undefined;

    return mapBrickToComponent<K>(artifact);
  };

  // Self-subscribe to store.watch for automatic cache invalidation.
  // External listeners registered via watch() also get notified.
  const externalListeners = new Set<(event: StoreChangeEvent) => void>();

  // let justified: mutable unsubscribe handle for store subscription cleanup
  let unsubStore: (() => void) | undefined;
  if (store.watch !== undefined) {
    unsubStore = store.watch((event) => {
      // Delta invalidation: only clear the specific brick for update/remove/promote.
      // "saved" (new brick) requires full invalidation since it may match filter criteria.
      const strategy = deltaInvalidator.classifyEvent(event);
      if (strategy === "full") {
        invalidateCache();
      } else {
        invalidateByBrickId(event.brickId);
      }
      // Snapshot to avoid issues if a listener unsubscribes during iteration
      const snapshot = [...externalListeners];
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (_: unknown) {
          // Never let one listener break others — silently continue
        }
      }
    });
  }

  const watch =
    store.watch !== undefined
      ? (listener: (event: StoreChangeEvent) => void): (() => void) => {
          if (externalListeners.size >= MAX_EXTERNAL_LISTENERS) {
            throw new Error(
              `ForgeRuntime: external listener limit (${String(MAX_EXTERNAL_LISTENERS)}) reached — likely a listener leak. ` +
                `Ensure returned unsubscribe functions are called.`,
            );
          }
          externalListeners.add(listener);
          return () => {
            externalListeners.delete(listener);
          };
        }
      : undefined;

  const dispose = (): void => {
    if (unsubStore !== undefined) {
      unsubStore();
      unsubStore = undefined;
    }
    externalListeners.clear();
    invalidateCache();
    store.dispose?.();
  };

  return {
    resolveTool,
    toolDescriptors,
    resolve,
    ...(watch !== undefined ? { watch } : {}),
    dispose,
  };
}
