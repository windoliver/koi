/**
 * @koi/tool-stack — Tool execution lifecycle meta-package (Layer 3)
 *
 * One-call composition of 7 middleware for tool auditing, limits, recovery,
 * dedup, sandbox, selection, and variant failover.
 *
 * Usage:
 * ```typescript
 * import { createToolStack } from "@koi/tool-stack";
 *
 * const { middleware } = createToolStack({
 *   audit: { onAuditResult: console.log },
 *   sandbox: { defaultTimeoutMs: 15_000, skipToolIds: ["memory_recall"] },
 *   limits: { globalLimit: 500 },
 * });
 * const runtime = await createKoi({ ..., middleware });
 * ```
 */

// ── Types: middleware sub-configs ────────────────────────────────────────
export type { CallDedupConfig } from "@koi/middleware-call-dedup";
export type { ToolCallLimitConfig } from "@koi/middleware-call-limits";
export type { DegenerateMiddlewareConfig } from "@koi/middleware-degenerate";
export type { ToolAuditConfig } from "@koi/middleware-tool-audit";
export type { ToolRecoveryConfig } from "@koi/middleware-tool-recovery";
export type { ToolSelectorConfig } from "@koi/middleware-tool-selector";
// ── Functions ───────────────────────────────────────────────────────────
export { createToolStack } from "./create-tool-stack.js";
// ── Types: tool stack bundle ────────────────────────────────────────────
export type { ToolStackBundle, ToolStackConfig, ToolStackSandboxConfig } from "./types.js";
