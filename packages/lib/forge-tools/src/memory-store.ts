/**
 * In-memory ForgeStore — Map-backed implementation for tests and the
 * default in-process forge tools backend.
 *
 * Task 3 scope: basic CRUD + sortable search + change notifications.
 * Task 4 scope: identity-content integrity, idempotent retry, terminal-lifecycle redrive rejection.
 * Optimistic locking + scope-update rejection land in Task 5.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickLifecycle,
  BrickSummary,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
} from "@koi/validation";
import {
  canonicalize,
  conflict,
  invariantViolation,
  notFound,
  recomputeBrickIdFromArtifact,
} from "./shared.js";

const TERMINAL_LIFECYCLES: ReadonlySet<BrickLifecycle> = new Set<BrickLifecycle>([
  "failed",
  "deprecated",
  "quarantined",
]);

function isTerminalLifecycle(l: BrickLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(l);
}

/**
 * Compare identity-bearing fields between two artifacts that share an id.
 * Uniform structural comparison over the full immutable artifact surface
 * so that omitted-but-set immutable fields (`files`, `requires`,
 * `configSchema`, `composition`, kind-specific `testCases` /
 * `counterexamples`, etc.) cannot alias under the same id.
 *
 * Strips mutable runtime metadata first so two retries that differ only in
 * usageCount, fitness, provenance.metadata.finishedAt, etc. are still equal.
 */
function isIdentityEqual(a: BrickArtifact, b: BrickArtifact): boolean {
  return canonicalize(stripMutable(a)) === canonicalize(stripMutable(b));
}

const MUTABLE_KEYS: ReadonlySet<string> = new Set([
  "lifecycle",
  "policy",
  "usageCount",
  "tags",
  "lastVerifiedAt",
  "fitness",
  "trailStrength",
  "driftContext",
  "collectiveMemory",
  "trigger",
  "namespace",
  "trustTier",
  "storeVersion",
  "signature",
  "provenance",
]);

/** Strip mutable runtime metadata so two bricks with same identity but different metadata compare equal. */
function stripMutable(b: BrickArtifact): unknown {
  return Object.fromEntries(Object.entries(b).filter(([k]) => !MUTABLE_KEYS.has(k)));
}

function notFoundError(id: BrickId): KoiError {
  return notFound(id, `Brick not found: ${id}`);
}

function toSummary(brick: BrickArtifact): BrickSummary {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    tags: brick.tags,
    ...(brick.trigger !== undefined ? { trigger: brick.trigger } : {}),
  };
}

export function createInMemoryForgeStore(): ForgeStore {
  const bricks = new Map<BrickId, BrickArtifact>();
  const notifier = createMemoryStoreChangeNotifier();
  // Indexes keep visibility-oriented lookups (forge_list) bounded to the
  // caller's own bricks plus globals, so peer-data volume cannot inflate
  // a list operation's cost.
  const byScope = new Map<string, Set<BrickId>>();
  const byScopeAndCreatedBy = new Map<string, Set<BrickId>>();

  const scopeKey = (scope: string): string => scope;
  const scopeCreatedByKey = (scope: string, agentId: string): string => `${scope}|${agentId}`;
  const addToIndex = (map: Map<string, Set<BrickId>>, key: string, id: BrickId): void => {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set<BrickId>();
      map.set(key, set);
    }
    set.add(id);
  };
  const removeFromIndex = (map: Map<string, Set<BrickId>>, key: string, id: BrickId): void => {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  };
  const indexInsert = (brick: BrickArtifact): void => {
    addToIndex(byScope, scopeKey(brick.scope), brick.id);
    const createdBy = brick.provenance.metadata.agentId;
    if (typeof createdBy === "string" && createdBy.length > 0) {
      addToIndex(byScopeAndCreatedBy, scopeCreatedByKey(brick.scope, createdBy), brick.id);
    }
  };
  const indexDelete = (brick: BrickArtifact): void => {
    removeFromIndex(byScope, scopeKey(brick.scope), brick.id);
    const createdBy = brick.provenance.metadata.agentId;
    if (typeof createdBy === "string" && createdBy.length > 0) {
      removeFromIndex(byScopeAndCreatedBy, scopeCreatedByKey(brick.scope, createdBy), brick.id);
    }
  };
  /** Pick the smallest candidate set for a given query (scope and/or createdBy). */
  const candidateBricks = (query: ForgeQuery): Iterable<BrickArtifact> => {
    if (query.scope !== undefined && query.createdBy !== undefined) {
      const set = byScopeAndCreatedBy.get(scopeCreatedByKey(query.scope, query.createdBy));
      if (set === undefined) return [];
      return mapIdsToBricks(set);
    }
    if (query.scope !== undefined) {
      const set = byScope.get(scopeKey(query.scope));
      if (set === undefined) return [];
      return mapIdsToBricks(set);
    }
    return bricks.values();
  };
  function* mapIdsToBricks(set: ReadonlySet<BrickId>): Generator<BrickArtifact> {
    for (const id of set) {
      const b = bricks.get(id);
      if (b !== undefined) yield b;
    }
  }

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    // Defense-in-depth: verify the caller-supplied BrickId matches the
    // canonical identity hash of the artifact's identity-bearing fields.
    // Rejects tampered, mis-keyed, or unsupported-kind inserts before they
    // can corrupt the map.
    let expectedId: BrickId;
    try {
      expectedId = recomputeBrickIdFromArtifact(brick);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: invariantViolation(`Cannot validate BrickId on save: ${message}`, {
          brickId: brick.id,
          kind: brick.kind,
        }),
      };
    }
    if (expectedId !== brick.id) {
      return {
        ok: false,
        error: invariantViolation(
          `BrickId mismatch on save: artifact identity hashes to ${expectedId} but was supplied as ${brick.id}`,
          { suppliedBrickId: brick.id, expectedBrickId: expectedId, kind: brick.kind },
        ),
      };
    }
    const existing = bricks.get(brick.id);
    if (existing !== undefined) {
      if (!isIdentityEqual(existing, brick)) {
        return {
          ok: false,
          error: invariantViolation(
            `BrickId collision: existing artifact ${brick.id} has different identity content`,
            { brickId: brick.id },
          ),
        };
      }
      if (isTerminalLifecycle(existing.lifecycle)) {
        return {
          ok: false,
          error: conflict(
            brick.id,
            `Brick is in terminal lifecycle ${existing.lifecycle}; bump version to redrive`,
            { existingBrickId: brick.id, lifecycle: existing.lifecycle },
          ),
        };
      }
      // Identity match, non-terminal lifecycle → idempotent success, do not overwrite metadata.
      return { ok: true, value: undefined };
    }
    // Deep-clone on ingress so callers cannot mutate stored state through
    // shared references on nested objects (provenance, schemas, tags, etc.).
    const stored: BrickArtifact = { ...structuredClone(brick), storeVersion: 1 };
    bricks.set(brick.id, stored);
    indexInsert(stored);
    notifier.notify({ kind: "saved", brickId: brick.id, scope: brick.scope });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) return { ok: false, error: notFoundError(id) };
    // Deep-clone on egress so callers cannot mutate stored state.
    return { ok: true, value: structuredClone(brick) };
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    // Use scope/createdBy indexes when available so visibility-oriented
    // queries (forge_list) do not pay the cost of every other tenant's data.
    const filtered: BrickArtifact[] = [];
    for (const brick of candidateBricks(query)) {
      if (matchesBrickQuery(brick, query)) filtered.push(brick);
    }
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });
    const limited = query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    // Deep-clone on egress so callers cannot mutate stored state.
    return { ok: true, value: limited.map((b) => structuredClone(b)) };
  };

  const searchSummaries = async (
    query: ForgeQuery,
  ): Promise<Result<readonly BrickSummary[], KoiError>> => {
    const result = await search(query);
    if (!result.ok) return result;
    return { ok: true, value: result.value.map(toSummary) };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) return { ok: false, error: notFoundError(id) };
    bricks.delete(id);
    indexDelete(existing);
    notifier.notify({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const existing = bricks.get(id);
    if (existing === undefined) return { ok: false, error: notFoundError(id) };
    if (updates.scope !== undefined && updates.scope !== existing.scope) {
      return {
        ok: false,
        error: invariantViolation(
          "scope is identity-bearing in @koi/forge-tools; resynthesize to change scope",
          { brickId: id, fromScope: existing.scope, toScope: updates.scope },
        ),
      };
    }
    const expected = updates.expectedVersion;
    const currentVersion = existing.storeVersion ?? 0;
    if (expected !== undefined && currentVersion !== expected) {
      return {
        ok: false,
        error: conflict(
          id,
          `Stale storeVersion: expected ${String(expected)}, current ${String(currentVersion)}`,
          { expectedVersion: expected, currentVersion },
        ),
      };
    }
    const baseApplied = applyBrickUpdate(existing, updates);
    // applyBrickUpdate (in @koi/validation) does not currently apply
    // `trigger`, `namespace`, or `trustTier`. Apply them here so the
    // store's update contract matches the full BrickUpdate surface.
    const applied: BrickArtifact = {
      ...baseApplied,
      ...(updates.trigger !== undefined ? { trigger: updates.trigger } : {}),
      ...(updates.namespace !== undefined ? { namespace: updates.namespace } : {}),
      ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
    };
    // Semantic no-op detection: compare canonical encoding of data fields.
    // If the patch produced no field-level change (or the patch contained
    // only control keys like `expectedVersion`), skip storeVersion bump and
    // watcher notify so idempotent retries do not manufacture false writes.
    if (canonicalize(applied) === canonicalize(existing)) {
      return { ok: true, value: undefined };
    }
    // Deep-clone so the stored record cannot be mutated through references
    // that survived applyBrickUpdate (e.g. arrays/objects from `updates`).
    const versioned: BrickArtifact = {
      ...structuredClone(applied),
      storeVersion: currentVersion + 1,
    };
    indexDelete(existing);
    bricks.set(id, versioned);
    indexInsert(versioned);
    notifier.notify({ kind: "updated", brickId: id, scope: versioned.scope });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: bricks.has(id) };
  };

  return {
    save,
    load,
    search,
    searchSummaries,
    remove,
    update,
    exists,
    watch: notifier.subscribe,
  };
}
