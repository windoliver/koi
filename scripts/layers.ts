/**
 * Canonical layer classification for the Koi monorepo.
 *
 * This is the single source of truth for which packages belong to which layer.
 * Both check-layers.ts and detect-layer.ts import from here.
 *
 * See docs/architecture/Koi.md for layer definitions.
 */

export const L0_PACKAGES: ReadonlySet<string> = new Set(["@koi/core"]);

/**
 * L0-utility packages — pure helpers with no business logic, depend on L0 + peer L0u only.
 * Importable by both L1 and L2 packages.
 */
export const L0U_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/acp-protocol",
  "@koi/channel-base",
  "@koi/crypto-utils",
  "@koi/dashboard-types",
  "@koi/edit-match",
  "@koi/errors",
  "@koi/event-delivery",
  "@koi/execution-context",
  "@koi/file-resolution",
  "@koi/git-utils",
  "@koi/harness-scheduler",
  "@koi/hash",
  "@koi/manifest",
  "@koi/nexus-client",
  "@koi/resolve",
  "@koi/sandbox-cloud-base",
  "@koi/scope",
  "@koi/search-provider",
  "@koi/shutdown",
  "@koi/skill-scanner",
  "@koi/snapshot-chain-store",
  "@koi/sqlite-utils",
  "@koi/test-utils",
  "@koi/token-estimator",
  "@koi/validation",
]);

export const L1_PACKAGES: ReadonlySet<string> = new Set(["@koi/engine"]);

/**
 * Meta-packages that bundle L0 + L1 + L2 — no new logic, only re-exports / orchestration.
 * L3 packages may depend on any layer.
 */
export const L3_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/autonomous",
  "@koi/cli",
  "@koi/context-arena",
  "@koi/governance",
  "@koi/starter",
]);
