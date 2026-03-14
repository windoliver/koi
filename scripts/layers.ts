/**
 * Canonical layer classification for the Koi monorepo.
 *
 * This is the single source of truth for which packages belong to which layer.
 * Both check-layers.ts and detect-layer.ts import from here.
 *
 * Keep in sync with CLAUDE.md L0u/L3 lists (CLAUDE.md references this file as canonical source).
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
  "@koi/cli-render",
  "@koi/crystallize",
  "@koi/crypto-utils",
  "@koi/dashboard-client",
  "@koi/dashboard-types",
  "@koi/delegation",
  "@koi/edit-match",
  "@koi/errors",
  "@koi/event-delivery",
  "@koi/execution-context",
  "@koi/failure-context",
  "@koi/file-resolution",
  "@koi/forge-types",
  "@koi/gateway-types",
  "@koi/git-utils",
  "@koi/harness-scheduler",
  "@koi/hash",
  "@koi/manifest",
  "@koi/name-resolution",
  "@koi/nexus-client",
  "@koi/preset-resolver",
  "@koi/resolve",
  "@koi/sandbox-cloud-base",
  "@koi/sandbox-wasm",
  "@koi/scope",
  "@koi/search-provider",
  "@koi/session-repair",
  "@koi/session-state",
  "@koi/shutdown",
  "@koi/skill-scanner",
  "@koi/snapshot-chain-store",
  "@koi/sqlite-utils",
  "@koi/task-board",
  "@koi/test-utils",
  "@koi/test-utils-contracts",
  "@koi/test-utils-mocks",
  "@koi/test-utils-store-contracts",
  "@koi/token-estimator",
  "@koi/validation",
  "@koi/variant-selection",
  "@koi/welford-stats",
]);

export const L1_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/engine",
  "@koi/engine-compose",
  "@koi/engine-reconcile",
]);

/**
 * Meta-packages that bundle L0 + L1 + L2 — no new logic, only re-exports / orchestration.
 * L3 packages may depend on any layer.
 */
export const L3_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/agent-spawner",
  "@koi/auto-harness",
  "@koi/autonomous",
  "@koi/channels",
  "@koi/cli",
  "@koi/context-arena",
  "@koi/data-source-stack",
  "@koi/forge",
  "@koi/gateway-stack",
  "@koi/goal-stack",
  "@koi/governance",
  "@koi/ipc-stack",
  "@koi/nexus",
  "@koi/node-stack",
  "@koi/quality-gate",
  "@koi/retry-stack",
  "@koi/rlm-stack",
  "@koi/sandbox-stack",
  "@koi/skill-stack",
  "@koi/starter",
  "@koi/temporal",
  "@koi/tool-stack",
  "@koi/workspace-stack",
]);

/**
 * L4 — single distributable package that absorbs all L3 + orphaned L2.
 * Published as the unscoped `koi` package.
 */
export const L4_PACKAGES: ReadonlySet<string> = new Set(["koi"]);
