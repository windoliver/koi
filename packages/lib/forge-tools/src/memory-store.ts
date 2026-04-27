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
 * Same id is the precondition; this verifies the precondition holds (i.e.
 * detects either tampering or a sha256 collision).
 */
function isIdentityEqual(a: BrickArtifact, b: BrickArtifact): boolean {
  if (a.kind !== b.kind) return false;
  if (a.name !== b.name) return false;
  if (a.description !== b.description) return false;
  if (a.version !== b.version) return false;
  if (a.scope !== b.scope) return false;
  if (a.kind === "tool" && b.kind === "tool") {
    // Use the same canonical representation as the identity hash so equivalent
    // schemas with different key insertion order are treated as equal.
    return (
      a.implementation === b.implementation &&
      canonicalize(a.inputSchema) === canonicalize(b.inputSchema) &&
      canonicalize(a.outputSchema ?? null) === canonicalize(b.outputSchema ?? null)
    );
  }
  if (a.kind === "middleware" && b.kind === "middleware") {
    return a.implementation === b.implementation;
  }
  if (a.kind === "channel" && b.kind === "channel") {
    return a.implementation === b.implementation;
  }
  if (a.kind === "skill" && b.kind === "skill") {
    return a.content === b.content;
  }
  if (a.kind === "agent" && b.kind === "agent") {
    return a.manifestYaml === b.manifestYaml;
  }
  // composite or unknown — be conservative: structural identity comparison
  // after stripping mutable runtime metadata. Canonicalize so key order
  // differences do not cause spurious mismatches.
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
    const filtered: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
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
    if (!bricks.has(id)) return { ok: false, error: notFoundError(id) };
    bricks.delete(id);
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
    // No-op detection: after stripping control fields, an empty patch produces
    // no change. Skip storeVersion bump and watcher notify so idempotent
    // retries don't appear as updates.
    const effectiveKeys = Object.keys(updates).filter((k) => k !== "expectedVersion");
    if (effectiveKeys.length === 0) {
      return { ok: true, value: undefined };
    }
    const applied = applyBrickUpdate(existing, updates);
    // Deep-clone so the stored record cannot be mutated through references
    // that survived applyBrickUpdate (e.g. arrays/objects from `updates`).
    const versioned: BrickArtifact = {
      ...structuredClone(applied),
      storeVersion: currentVersion + 1,
    };
    bricks.set(id, versioned);
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
