/**
 * Shared brick resolution utilities — extracted from ForgeRuntime and
 * ForgeComponentProvider to eliminate DRY violations.
 *
 * Provides:
 * - `mapBrickToComponent` — exhaustive switch over BrickKind to create
 *   ECS component values (shared by both ForgeRuntime.resolve() and
 *   ForgeComponentProvider.attachBrick())
 * - `createDeltaInvalidator` — targeted cache invalidation by brickId
 *   instead of blanket clear
 * - Trust tier enforcement helpers
 */

import type {
  AgentDescriptor,
  BrickArtifact,
  BrickComponentMap,
  BrickId,
  BrickKind,
  ForgeScope,
  SkillComponent,
  StoreChangeEvent,
  StoreChangeKind,
  TrustTier,
} from "@koi/core";
import { MIN_TRUST_BY_KIND } from "@koi/core";

// ---------------------------------------------------------------------------
// Trust tier enforcement
// ---------------------------------------------------------------------------

/** Trust tier ordering: sandbox < verified < promoted. */
const TRUST_TIER_LEVEL: Readonly<Record<TrustTier, number>> = {
  sandbox: 0,
  verified: 1,
  promoted: 2,
} as const;

/** Returns true if `actual` meets or exceeds `required` trust tier. */
export function meetsMinTrust(actual: TrustTier, required: TrustTier): boolean {
  return TRUST_TIER_LEVEL[actual] >= TRUST_TIER_LEVEL[required];
}

/** Returns true if the brick's trust tier meets the minimum for its kind. */
export function meetsKindTrust(brick: BrickArtifact): boolean {
  const minTrust = MIN_TRUST_BY_KIND[brick.kind];
  return meetsMinTrust(brick.trustTier, minTrust);
}

// ---------------------------------------------------------------------------
// Brick → component mapping
// ---------------------------------------------------------------------------

/**
 * Map a BrickArtifact to its ECS component value based on kind.
 *
 * Returns `undefined` if the brick kind is unrecognized.
 *
 * Justified `as BrickComponentMap[K]` casts: TypeScript cannot prove
 * that when artifact.kind === "skill", the generic K is narrowed to "skill".
 * Each branch is individually type-safe.
 */
export function mapBrickToComponent<K extends BrickKind>(
  artifact: BrickArtifact,
): BrickComponentMap[K] | undefined {
  switch (artifact.kind) {
    case "skill": {
      const component: SkillComponent = {
        name: artifact.name,
        description: artifact.description,
        content: artifact.content,
        ...(artifact.tags.length > 0 ? { tags: artifact.tags } : {}),
      };
      return component as BrickComponentMap[K];
    }
    case "agent": {
      const component: AgentDescriptor = {
        name: artifact.name,
        description: artifact.description,
        manifestYaml: artifact.manifestYaml,
      };
      return component as BrickComponentMap[K];
    }
    case "middleware":
    case "channel":
      return artifact as BrickComponentMap[K];
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Delta invalidation
// ---------------------------------------------------------------------------

export interface DeltaInvalidator<V> {
  /** Targeted invalidation by brick ID — removes single entry if cached. */
  readonly invalidateByBrickId: (brickId: BrickId, cache: Map<string, V>) => boolean;
  /** Targeted invalidation by scope — removes all entries of matching scope. */
  readonly invalidateByScope: (
    scope: ForgeScope,
    scopeTracker: ReadonlyMap<string, ForgeScope>,
  ) => boolean;
  /**
   * Determine invalidation strategy from a store change event.
   * Returns "full" if the cache should be fully cleared, "delta" if targeted,
   * or "none" if no invalidation needed.
   */
  readonly classifyEvent: (event: StoreChangeEvent) => "full" | "delta" | "none";
}

/**
 * Create a delta invalidator for targeted cache eviction.
 *
 * Strategy per event kind:
 * - "saved" → full (new brick may match cache filter criteria)
 * - "removed" → delta (only the specific brick needs eviction)
 * - "updated" → delta (only the specific brick needs eviction)
 * - "promoted" → delta (scope/tier changed for specific brick)
 */
export function createDeltaInvalidator<V>(): DeltaInvalidator<V> {
  const classifyEvent = (event: StoreChangeEvent): "full" | "delta" | "none" => {
    const kind: StoreChangeKind = event.kind;
    switch (kind) {
      case "saved":
        // New brick — could match any filter; full invalidation is safest
        return "full";
      case "removed":
      case "updated":
      case "promoted":
        return "delta";
    }
  };

  const invalidateByBrickId = (brickId: BrickId, cache: Map<string, V>): boolean => {
    // Cache is keyed by name, but we need to find by brickId.
    // Iterate to find and remove the matching entry.
    for (const [key, value] of cache) {
      if (typeof value === "object" && value !== null && "id" in value) {
        const artifact = value as { readonly id: string };
        if (artifact.id === brickId) {
          cache.delete(key);
          return true;
        }
      }
    }
    return false;
  };

  const invalidateByScope = (
    scope: ForgeScope,
    scopeTracker: ReadonlyMap<string, ForgeScope>,
  ): boolean => {
    for (const [, brickScope] of scopeTracker) {
      if (brickScope === scope) {
        return true; // Signal that full invalidation is needed for this scope
      }
    }
    return false;
  };

  return { classifyEvent, invalidateByBrickId, invalidateByScope };
}
