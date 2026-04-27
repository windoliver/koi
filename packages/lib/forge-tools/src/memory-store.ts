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
import { conflict, invariantViolation, notFound } from "./shared.js";

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
    return (
      a.implementation === b.implementation &&
      JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) &&
      JSON.stringify(a.outputSchema ?? null) === JSON.stringify(b.outputSchema ?? null)
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
  // after stripping mutable runtime metadata.
  return JSON.stringify(stripMutable(a)) === JSON.stringify(stripMutable(b));
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
    const stored: BrickArtifact = { ...brick, storeVersion: 1 };
    bricks.set(brick.id, stored);
    notifier.notify({ kind: "saved", brickId: brick.id, scope: brick.scope });
    return { ok: true, value: undefined };
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const brick = bricks.get(id);
    if (brick === undefined) return { ok: false, error: notFoundError(id) };
    return { ok: true, value: brick };
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const filtered: BrickArtifact[] = [];
    for (const brick of bricks.values()) {
      if (matchesBrickQuery(brick, query)) filtered.push(brick);
    }
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });
    const limited = query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    return { ok: true, value: limited };
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
    const applied = applyBrickUpdate(existing, updates);
    const versioned: BrickArtifact = { ...applied, storeVersion: currentVersion + 1 };
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
