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
  "@koi/bash-ast",
  "@koi/bash-security",
  "@koi/channel-base",
  "@koi/config",
  "@koi/context-manager",
  "@koi/edit-match",
  "@koi/errors",
  "@koi/event-delivery",
  "@koi/execution-context",
  "@koi/file-resolution",
  "@koi/git-utils",
  "@koi/hash",
  "@koi/hook-prompt",
  "@koi/model-registry",
  "@koi/redaction",
  "@koi/rules-loader",
  "@koi/secure-storage",
  "@koi/session-repair",
  "@koi/shutdown",
  "@koi/skill-scanner",
  "@koi/task-board",
  "@koi/test",
  "@koi/token-estimator",
  "@koi/tools-core",
  "@koi/validation",
]);

export const L1_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/engine",
  "@koi/engine-compose",
  "@koi/engine-reconcile",
]);

export const L2_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/audit-sink-ndjson",
  "@koi/audit-sink-sqlite",
  "@koi/mcp",
  "@koi/middleware-audit",
  "@koi/plugins",
  "@koi/sandbox-os",
  "@koi/session",
  "@koi/skill-tool",
  "@koi/skills-runtime",
  "@koi/task-tools",
  "@koi/tasks",
  "@koi/tools-bash",
]);

/**
 * Meta-packages that bundle L0 + L1 + L2 — no new logic, only re-exports / orchestration.
 * L3 packages may depend on any layer.
 */
export const L3_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/cli",
  "@koi-agent/cli",
  "@koi/runtime",
]);

/**
 * L4 — single distributable package that absorbs all L3 + orphaned L2.
 * Published as the unscoped `koi` package.
 */
export const L4_PACKAGES: ReadonlySet<string> = new Set([]);
