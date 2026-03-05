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
  "@koi/crystallize",
  "@koi/crypto-utils",
  "@koi/dashboard-types",
  "@koi/delegation",
  "@koi/edit-match",
  "@koi/errors",
  "@koi/event-delivery",
  "@koi/execution-context",
  "@koi/file-resolution",
  "@koi/forge-types",
  "@koi/gateway-types",
  "@koi/git-utils",
  "@koi/harness-scheduler",
  "@koi/hash",
  "@koi/manifest",
  "@koi/name-resolution",
  "@koi/nexus-client",
  "@koi/resolve",
  "@koi/sandbox-cloud-base",
  "@koi/sandbox-wasm",
  "@koi/scope",
  "@koi/search-provider",
  "@koi/session-repair",
  "@koi/shutdown",
  "@koi/skill-scanner",
  "@koi/snapshot-chain-store",
  "@koi/sqlite-utils",
  "@koi/test-utils",
  "@koi/token-estimator",
  "@koi/validation",
  "@koi/variant-selection",
]);

export const L1_PACKAGES: ReadonlySet<string> = new Set(["@koi/engine"]);

/**
 * Meta-packages that bundle L0 + L1 + L2 — no new logic, only re-exports / orchestration.
 * L3 packages may depend on any layer.
 */
export const L3_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/agent-spawner",
  "@koi/autonomous",
  "@koi/channels",
  "@koi/cli",
  "@koi/context-arena",
  "@koi/forge",
  "@koi/gateway-stack",
  "@koi/goal-stack",
  "@koi/governance",
  "@koi/ipc-stack",
  "@koi/middleware-personalization", // deprecation shim — delegates to @koi/middleware-user-model
  "@koi/middleware-preference", // deprecation shim — delegates to @koi/middleware-user-model
  "@koi/nexus",
  "@koi/node-stack",
  "@koi/quality-gate",
  "@koi/retry-stack",
  "@koi/rlm-stack",
  "@koi/sandbox-cloud",
  "@koi/sandbox-stack",
  "@koi/starter",
  "@koi/tool-stack",
  "@koi/workspace-stack",
]);
