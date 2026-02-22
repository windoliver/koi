/**
 * ForgeStore interface — Repository pattern for brick persistence.
 */

import type { KoiError, Result, TrustTier } from "@koi/core";
import type { BrickArtifact, BrickLifecycle, ForgeQuery, ForgeScope } from "./types.js";

export type { BrickArtifact, ForgeQuery };

export interface BrickUpdate {
  readonly lifecycle?: BrickLifecycle;
  readonly trustTier?: TrustTier;
  readonly scope?: ForgeScope;
  readonly usageCount?: number;
}

export interface ForgeStore {
  readonly save: (brick: BrickArtifact) => Promise<Result<void, KoiError>>;
  readonly load: (id: string) => Promise<Result<BrickArtifact, KoiError>>;
  readonly search: (query: ForgeQuery) => Promise<Result<readonly BrickArtifact[], KoiError>>;
  readonly remove: (id: string) => Promise<Result<void, KoiError>>;
  readonly update: (id: string, updates: BrickUpdate) => Promise<Result<void, KoiError>>;
}
