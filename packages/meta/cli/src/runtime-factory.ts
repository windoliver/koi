/**
 * TUI runtime factory — assembles the full L2 tool stack for `koi tui`.
 *
 * Wires:
 *   @koi/event-trace          — in-memory trajectory recording (for /trajectory view)
 *   @koi/hooks                — command hook dispatch
 *   @koi/permissions          — permission backend (default mode)
 *   @koi/middleware-permissions — permission gating middleware
 *   @koi/tools-builtin        — Glob, Grep, ToolSearch providers
 *   @koi/fs-local             — local filesystem backend
 *   @koi/sandbox-os           — OS sandbox adapter (auto-applied to Bash via DI)
 *   @koi/tools-bash           — Bash execution (sandboxed when adapter available) + bash_background
 *   @koi/tasks                — in-memory task board for background job tracking
 *   @koi/task-tools           — task_create, task_get, task_update, task_list, task_stop, task_output
 *   @koi/tools-web            — web_fetch
 *   @koi/tool-notebook        — notebook_read, notebook_add_cell, notebook_replace_cell, notebook_delete_cell
 *   @koi/session              — JSONL transcript recording (optional, via config.session)
 *   @koi/engine               — system prompt middleware (optional, via config.systemPrompt)
 *   @koi/skills-runtime        — three-tier skill discovery (bundled → user → project)
 *   @koi/skill-tool            — on-demand skill loading meta-tool (Skill)
 *
 * MCP wired: loads .mcp.json, creates resolver + provider, bridges MCP tools → skills.
 * Hook loading from user config is deferred — currently passes empty hooks.
 *
 * Returns the KoiRuntime, the mutable transcript array (for session resets),
 * and a getTrajectorySteps() accessor for the /trajectory TUI command.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";
import { createSqliteAuditSink } from "@koi/audit-sink-sqlite";
import type { Checkpoint } from "@koi/checkpoint";
import { createConfigManager } from "@koi/config";
import type { BudgetConfig } from "@koi/context-manager";
import type {
  Agent,
  ApprovalHandler,
  AuditSink,
  ComplianceRecorder,
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  FileSystemBackend,
  GovernanceBackend,
  GovernanceController,
  GovernanceVerdict,
  InboundMessage,
  KoiMiddleware,
  ModelAdapter,
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
  PolicyRequest,
  RichTrajectoryStep,
  RuleDescriptor,
  SessionId,
  SessionTranscript,
  ViolationStore,
} from "@koi/core";
import { COMPONENT_PRIORITY, GOVERNANCE, agentId as makeAgentId } from "@koi/core";
import { DEFAULT_PRICING, resolvePricing } from "@koi/cost-aggregator";
import type { DecisionLedgerReader } from "@koi/decision-ledger";
import { createDecisionLedger } from "@koi/decision-ledger";
import type { GovernanceConfig, KoiRuntime } from "@koi/engine";
import { createGovernanceController, createKoi } from "@koi/engine";
import { createLocalFileSystem, resolveFsPath } from "@koi/fs-local";
import type { CostCalculator } from "@koi/governance-core";
import { createGovernanceMiddleware } from "@koi/governance-core";
import type { PatternRule } from "@koi/governance-defaults";
import {
  createAuditSinkComplianceRecorder,
  createPatternBackend,
  fanOutComplianceRecorder,
} from "@koi/governance-defaults";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import {
  createFeedbackLoopMiddleware,
  type FeedbackLoopConfig,
} from "@koi/middleware-feedback-loop";
import type { OtelMiddlewareConfig } from "@koi/middleware-otel";
import type { ApprovalStore } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createPlanPersistMiddleware } from "@koi/middleware-plan-persist";
import { createPlanMiddleware } from "@koi/middleware-planning";
import { createReportMiddleware } from "@koi/middleware-report";
import type { CompiledRule, SourcedRule } from "@koi/permissions";
import {
  compileGlob,
  createPermissionBackend,
  evaluateRules,
  mapSettingsToSourcedRules,
  SOURCE_PRECEDENCE,
  widenCommandScopedRulesForTui,
} from "@koi/permissions";
import { wrapMiddlewareWithTrace } from "@koi/runtime";
import { loadSettings } from "@koi/settings";
import type { SkillsRuntime } from "@koi/skills-runtime";
import { createSqliteViolationStore } from "@koi/violation-store-sqlite";
import {
  buildInheritedMiddlewareForChildren,
  composeRuntimeMiddleware,
} from "./compose-middleware.js";
import { budgetConfigForModel, createTranscriptAdapter } from "./engine-adapter.js";
import type { ManifestMiddlewareEntry } from "./manifest.js";
import {
  canonicalizeAuditSinkPath,
  createBuiltinManifestRegistry,
  type ManifestMiddlewareContext,
  type MiddlewareRegistry,
  resolveManifestMiddleware,
} from "./middleware-registry.js";
import type { PluginDiscoverySummary } from "./plugin-activation.js";
import { loadPluginComponents } from "./plugin-activation.js";
import { activateStacks, LATE_PHASE_HOST_KEYS, mergeStackContributions } from "./preset-stacks.js";
import { enforceRequiredMiddleware } from "./required-middleware.js";
import {
  buildCoreMiddleware,
  buildCoreProviders,
  loadUserRegisteredHooks,
  mergeUserAndPluginHooks,
} from "./shared-wiring.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import { MAX_TRAJECTORY_STEPS } from "./preset-stacks/observability.js";

/**
 * Maximum trajectory steps retained in the in-memory store for
 * `/trajectory` view. Re-exported so host commands can import the cap
 * alongside `createKoiRuntime`. Source of truth is the observability
 * preset stack.
 */
export { MAX_TRAJECTORY_STEPS };

/**
 * Maximum model→tool→model turns per user submit in the TUI.
 *
 * Bumped from 10 → 25 so that exploratory flows (the model running multiple
 * small probes before answering) can finish instead of truncating mid-probe
 * with a "Turn ended: max-turns budget reached" synthetic message. 25 matches
 * the kernel/engine-loop default (`packages/drivers/engine-loop/... DEFAULT_MAX_TURNS`)
 * and keeps runaway agent loops bounded on the same order as before.
 */
const DEFAULT_MAX_TURNS = 25;

/**
 * Default spawn fan-out used when --max-spawn-depth is set without a
 * companion fan-out override. Matches DEFAULT_GOVERNANCE_CONFIG.spawn.maxFanOut
 * in @koi/engine-reconcile so the runtime-factory does not silently widen
 * the engine's default when the operator only tightens depth.
 */
const DEFAULT_MAX_FAN_OUT = 5;

/** Maximum messages retained in the transcript context window.
 * Matches the default for `koi start --context-window` (100).
 * A lower cap (e.g. 20) causes the model to silently lose context
 * after ~10 exchanges with no compaction to preserve it. */
const MAX_TRANSCRIPT_MESSAGES = 100;

// ---------------------------------------------------------------------------
// TUI permission constants (exported for testing — #1845)
// ---------------------------------------------------------------------------

/**
 * Interactive approval timeout for the TUI — 60 minutes.
 *
 * Agent-to-agent callers keep the 30s engine default (fail-closed).
 * The TUI uses a long timeout so real users are never auto-denied while
 * reading a permission prompt. Finite (not Infinity) so a wedged renderer
 * eventually fails closed rather than hanging forever.
 *
 * @see docs/L2/tui.md §approval-timeout
 */
export const TUI_APPROVAL_TIMEOUT_MS: number = 60 * 60 * 1_000; // 3_600_000

/**
 * Static TUI allow rules — tools that are auto-allowed without user approval.
 *
 * Excludes `fs_read` (needs dynamic `cwd`-scoped context) — those are appended
 * at runtime inside `createKoiRuntime`.
 *
 * Allowlist reasoning:
 * - Glob, Grep, ToolSearch — filesystem search, no mutations
 * - task_* — task board reads/writes (own state, not workspace files)
 * - Skill — skill invocation (own state)
 * - memory_store/recall/search — sandboxed to .koi/memory/, non-destructive
 *
 * Tools that fall to "ask" (mode-default for unmatched tools):
 * - Bash, bash_background, web_fetch, fs_write, fs_edit
 * - memory_delete — deletes durable cross-session state
 * - notebook_* — read/write .ipynb files on disk; notebook_read bypasses
 *   the filesystemOperations gate if auto-allowed, so all notebook tools
 *   stay gated for consistency with fs_read
 *
 * The TUI sets TUI_APPROVAL_TIMEOUT_MS (60 min) so interactive users are
 * never auto-denied while reading an "ask" prompt (#1845).
 */
export const TUI_ALLOW_RULES: readonly SourcedRule[] = [
  { pattern: "Glob", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "Grep", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "ToolSearch", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_get", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_list", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_output", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_create", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_update", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "task_stop", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "Skill", action: "invoke", effect: "allow", source: "policy" },
  // Memory tools — non-destructive ops sandboxed to .koi/memory/
  // memory_delete intentionally NOT auto-allowed — deletes durable on-disk state
  { pattern: "memory_store", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "memory_recall", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "memory_search", action: "invoke", effect: "allow", source: "policy" },
] as const;

/**
 * Auto-allow rule for `write_plan`. Opt-in only: installed ONLY when
 * `config.planningEnabled === true`. Matched by bare tool name, which
 * is the same matching the rest of the allowlist uses — but since it
 * is gated on planningEnabled, a host that does not opt into the
 * planning middleware will never install this rule even if a
 * third-party tool happens to share the name.
 */
export const TUI_WRITE_PLAN_ALLOW_RULE: SourcedRule = {
  // Namespaced tool id. See WRITE_PLAN_TOOL_NAME in @koi/middleware-planning.
  pattern: "koi_plan_write",
  action: "invoke",
  effect: "allow",
  source: "policy",
};

/**
 * Auto-allow rules for `koi_plan_save` / `koi_plan_load` — installed
 * alongside `TUI_WRITE_PLAN_ALLOW_RULE` only when planning is opted
 * in. Both are no-side-effect-outside-baseDir by construction (the
 * plan-persist adapter validates baseDir against cwd at construction
 * and rejects path traversal at the tool boundary), so they are safe
 * to auto-allow.
 */
export const TUI_PLAN_PERSIST_ALLOW_RULES: readonly SourcedRule[] = [
  { pattern: "koi_plan_save", action: "invoke", effect: "allow", source: "policy" },
  { pattern: "koi_plan_load", action: "invoke", effect: "allow", source: "policy" },
];

// ---------------------------------------------------------------------------
// Cost config helpers
// ---------------------------------------------------------------------------

/**
 * Resolve governance cost config from the user's --max-spend flag and every
 * model the runtime might call. The controller stores ONE per-token rate
 * pair, and the engine-reconcile extension's `controller.record({ kind:
 * "token_usage" })` calls do not attach a per-call `costUsd`. That means a
 * router fallback to a differently-priced model would accumulate spend
 * against the primary's rate — silently breaking `--max-spend` for the
 * fallback path.
 *
 * Validation rules (all enforced at startup, fail-fast):
 *   1. Every model in the chain must have a `DEFAULT_PRICING` entry.
 *   2. Every fallback's per-token rates must equal the primary's. Until
 *      engine-reconcile records per-call `costUsd`, mixed-rate routing
 *      cannot honor a single setpoint.
 */
function resolveCostConfig(
  maxCostUsd: number,
  modelChain: readonly string[],
): {
  readonly maxCostUsd: number;
  readonly costPerInputToken: number;
  readonly costPerOutputToken: number;
} {
  if (modelChain.length === 0) {
    throw new Error("koi: resolveCostConfig requires at least the primary model name");
  }
  const unpriced = modelChain.filter((m) => resolvePricing(m, DEFAULT_PRICING) === undefined);
  if (unpriced.length > 0) {
    throw new Error(
      `koi: --max-spend $${maxCostUsd} set but the following model(s) have no pricing in ` +
        `DEFAULT_PRICING: ${unpriced.join(", ")}. The cost cap would not accumulate when the ` +
        `router targets them. Add the missing models to @koi/cost-aggregator's DEFAULT_PRICING ` +
        `table or omit --max-spend.`,
    );
  }
  // unpriced.length === 0 guarantees every entry has pricing.
  const [primary, ...fallbacks] = modelChain as readonly [string, ...string[]];
  const primaryPricing = resolvePricing(primary, DEFAULT_PRICING) as NonNullable<
    ReturnType<typeof resolvePricing>
  >;
  const mismatched = fallbacks.filter((m) => {
    const p = resolvePricing(m, DEFAULT_PRICING);
    return p?.input !== primaryPricing.input || p?.output !== primaryPricing.output;
  });
  if (mismatched.length > 0) {
    throw new Error(
      `koi: --max-spend $${maxCostUsd} set but fallback model(s) [${mismatched.join(", ")}] ` +
        `have different per-token rates than primary "${primary}" ` +
        `($${primaryPricing.input}/in, $${primaryPricing.output}/out). ` +
        `The controller stores one rate pair, so mixed-pricing routing would mis-charge spend. ` +
        `Use a fallback chain with matching pricing, drop --max-spend, or omit KOI_FALLBACK_MODEL.`,
    );
  }
  return {
    maxCostUsd,
    costPerInputToken: primaryPricing.input,
    costPerOutputToken: primaryPricing.output,
  };
}

// ---------------------------------------------------------------------------
// Shared governance controller helpers
// ---------------------------------------------------------------------------

/**
 * Default-allow pattern backend with no rules. Used when the caller did not
 * pass `--policy-file` / `manifest.governance.policyFile` (gov-10). With no
 * rules to evaluate, the backend accepts every call and `describeRules()`
 * returns []. The runtime synthesizes a `default-allow` descriptor below so
 * the /governance "Active rules" section renders something the operator can
 * read.
 */
function createDefaultPatternBackend(): GovernanceBackend {
  return createPatternBackend({ rules: [], defaultDeny: false });
}

/** Synthetic descriptor used when the backend reports no rules. */
const SYNTHETIC_DEFAULT_ALLOW: RuleDescriptor = {
  id: "default-allow",
  description:
    "no rules configured; all calls allowed (pass --policy-file or set manifest.governance.policyFile)",
  effect: "allow",
  pattern: "*",
};

/**
 * Resolve the rule list for `/governance` — call `backend.describeRules()` if
 * the backend exposes it, fall back to the synthetic default-allow entry when
 * empty. Errors degrade to the synthetic entry rather than crashing the
 * runtime — the rule list is observational, not on the gating path.
 */
async function resolveGovernanceRules(
  backend: GovernanceBackend,
): Promise<readonly RuleDescriptor[]> {
  if (backend.describeRules === undefined) return [SYNTHETIC_DEFAULT_ALLOW];
  try {
    const rules = await backend.describeRules();
    return rules.length > 0 ? rules : [SYNTHETIC_DEFAULT_ALLOW];
  } catch (err: unknown) {
    console.warn("[koi runtime] governance describeRules() failed:", err);
    return [SYNTHETIC_DEFAULT_ALLOW];
  }
}

/**
 * Lightweight CostCalculator that resolves per-model rates from
 * @koi/cost-aggregator's DEFAULT_PRICING. Returns 0 for unknown models so the
 * middleware doesn't throw on first call.
 */
function createPricingCostCalculator(): CostCalculator {
  return {
    calculate(model: string, inputTokens: number, outputTokens: number): number {
      const pricing = resolvePricing(model, DEFAULT_PRICING);
      if (pricing === undefined) return 0;
      return inputTokens * pricing.input + outputTokens * pricing.output;
    },
  };
}

/**
 * Build a ComponentProvider that contributes a pre-existing GovernanceController
 * with GLOBAL_FORGED priority so it wins over the bundled BUNDLED-priority
 * provider createKoi adds automatically. This lets us use the SAME controller in
 * the runtime, the bridge, and the L2 governance middleware.
 */
function createSharedGovernanceProvider(controller: GovernanceController): ComponentProvider {
  return {
    name: "koi:cli:shared-governance",
    priority: COMPONENT_PRIORITY.GLOBAL_FORGED,
    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      return new Map<string, unknown>([[GOVERNANCE as string, controller]]);
    },
  };
}

// ---------------------------------------------------------------------------
// Config & return types
// ---------------------------------------------------------------------------

export interface KoiRuntimeConfig {
  /**
   * When true, skip loading `~/.koi/hooks.json`. Per-invocation config
   * instead of the global KOI_DISABLE_HOOKS env var so concurrent
   * runtimes in the same process don't interfere with each other's hook
   * policy. `koi start --headless` sets this true by default (issue
   * #1648); interactive hosts leave it undefined.
   */
  readonly disableUserHooks?: boolean | undefined;
  /**
   * When true, build the default local filesystem backend with
   * `allowExternalPaths: false` so whitelisted `fs_*` tools cannot
   * escape the workspace via absolute paths or `..` segments. Only
   * applies when `config.filesystem` is not explicitly provided.
   * `koi start --headless` sets this true by default to prevent a
   * `--allow-tool fs_read` from reading `/etc/passwd` on a CI runner.
   */
  readonly workspaceOnlyFs?: boolean | undefined;
  /** Model HTTP adapter — its complete/stream terminals are exposed to middleware. */
  readonly modelAdapter: ModelAdapter;
  /** Model name for ATIF metadata. */
  readonly modelName: string;
  /** Approval handler for permission prompts — should be permissionBridge.handler. */
  readonly approvalHandler: ApprovalHandler;
  /**
   * Override the built-in permission backend. When omitted, the factory
   * uses `default`-mode with the TUI's tiered allow rules (pre-allowed
   * read-only tools, everything else falls through to "ask"). Hosts that
   * need a different posture (e.g. `koi start` auto-allows everything
   * because the plain REPL has no interactive approval UI) pass their
   * own backend here.
   */
  readonly permissionBackend?: PermissionBackend | undefined;
  /**
   * Description label for the permissions middleware — shown in error
   * messages and trace steps. Defaults to "koi tui — default permission
   * mode". `koi start` passes "koi start — auto-allow".
   */
  readonly permissionsDescription?: string | undefined;
  /**
   * When `true`, the Bash AST-walker's `elicit` fallback auto-allows
   * every prompt instead of going through the approval handler. The
   * TUI passes this when `--yolo` is active so the TTP-classifier
   * path does not re-prompt for commands the walker cannot parse
   * (e.g. `cmd && cmd 2>&1` lists with redirects). Defaults to `false`.
   */
  readonly bashElicitAutoApprove?: boolean | undefined;
  /**
   * Default per-submit wall-clock cap in ms. When omitted the factory
   * uses 1_800_000 (30 min) — matches the interactive TUI posture.
   * Non-interactive hosts (`koi start`) pass a tighter value (300_000
   * / 5 min) so a runaway active loop has a smaller blast radius.
   *
   * Always overridable via `KOI_MAX_DURATION_MS` env var. Use `0` in
   * the env var to disable the cap entirely (clamped to setTimeout's
   * int32 max, ~24.8 days).
   */
  readonly defaultMaxDurationMs?: number | undefined;
  /**
   * Maximum cumulative spend in USD before the governance controller
   * fires a violation. When >0, the runtime resolves per-token pricing
   * for `modelName` via @koi/cost-aggregator's DEFAULT_PRICING and
   * configures `governance.cost.{maxCostUsd,costPerInputToken,costPerOutputToken}`.
   * Unknown models cause `createKoiRuntime` to throw at startup so the
   * budget can never be silently ignored.
   * 0 (default) keeps cost tracking disabled.
   */
  readonly maxSpendUsd?: number | undefined;
  /**
   * Fallback model names from the model-router (KOI_FALLBACK_MODEL chain).
   * Validated alongside the primary `modelName` when `--max-spend` is set —
   * any unpriced entry refuses startup so a router fallback can never bypass
   * the budget. Empty / undefined means no router is wired.
   */
  readonly fallbackModelNames?: readonly string[] | undefined;
  /**
   * Maximum number of completed turns before the governance controller fires
   * a violation. Wired from `--max-turns`. Overrides `DEFAULT_MAX_TURNS`.
   */
  readonly maxTurns?: number | undefined;
  /**
   * Maximum depth of spawned sub-agents before the governance controller
   * fires a violation. Wired from `--max-spawn-depth`.
   */
  readonly maxSpawnDepth?: number | undefined;
  /**
   * Per-variable alert thresholds for the L2 governance middleware. Each
   * entry must be in (0, 1]. Overrides the default `[0.8, 0.95]` when set.
   * Wired from the repeatable `--alert-threshold` flag.
   */
  readonly governanceAlertThresholds?: readonly number[] | undefined;
  /**
   * Pattern rules for the L2 governance backend's `backend.evaluator`. Wired
   * from `--policy-file`. Undefined means "no rules configured" and the
   * synthetic `default-allow` descriptor shows in `/governance`.
   */
  readonly governanceRules?: readonly PatternRule[] | undefined;
  /**
   * When true, skip the governance wiring entirely — no controller, backend,
   * middleware, or bridge is installed. Wired from `--no-governance`. Hosts
   * using a custom governance stack (or running without one) pass this to
   * avoid the default observer-mode middleware.
   */
  readonly governanceDisabled?: boolean | undefined;
  /**
   * Approval timeout in ms for permission "ask" decisions. Defaults to
   * the middleware's 30s fail-closed posture (suitable for agent-to-agent
   * and non-interactive callers). The TUI passes `TUI_APPROVAL_TIMEOUT_MS`
   * (60 min) so interactive users are never auto-denied while reading a
   * permission prompt (#1845).
   */
  readonly approvalTimeoutMs?: number | undefined;
  /**
   * Stable identifier used as the `hostId` on spawn events, decision-
   * ledger lookups, and permission persistentAgentId. Defaults to
   * "koi-tui" for backward compatibility. `koi start` passes "koi-cli".
   */
  readonly hostId?: string | undefined;
  /**
   * EngineAdapter `engineId` — surfaced in error messages and trace
   * metadata. Defaults to "koi-tui". `koi start` passes "koi-cli".
   */
  readonly engineId?: string | undefined;
  /**
   * Optional loop-mode generation fence for `koi start --until-pass`.
   * When set, the transcript adapter snapshots this at stream-start
   * and skips the commit-on-done path if the generation has advanced
   * (orphan fence, #1624). The TUI never sets this because it has no
   * convergence-loop driver.
   */
  readonly getGeneration?: (() => number) | undefined;
  /**
   * Opt-in subset of preset stacks to activate. When `undefined`
   * (default), every stack in `DEFAULT_STACKS` is activated —
   * matching v1's "wire everything" posture. Hosts that need a
   * stripped-down assembly (e.g. a CI runner without notebook
   * tools) pass an explicit list. Manifest YAML surfaces this
   * through a `stacks:` key; see `loadManifestConfig`.
   */
  readonly stacks?: readonly string[] | undefined;
  /**
   * Opt-in allowlist of plugin names to activate. When `undefined`
   * (default), every plugin discovered in `~/.koi/plugins/` is
   * activated — matches the prior filesystem-scan behavior. An
   * empty array disables every plugin (useful for reproducible CI
   * assemblies). Manifest YAML surfaces this through a `plugins:`
   * key; see `loadManifestConfig`.
   */
  readonly plugins?: readonly string[] | undefined;
  /**
   * Zone B — ordered, user-controlled middleware resolved from
   * `manifest.middleware`. Each entry names a middleware registered
   * in `middlewareRegistry` and carries optional factory options.
   * Order is authoritative within zone B; the resolved chain
   * always sits between zone A (preset stacks) and zone C
   * (required core), per `composeRuntimeMiddleware`.
   *
   * Unknown names throw `UnknownManifestMiddlewareError` at factory
   * time with the full registered-name list. Core middleware names
   * (`hook`, `permissions`, `exfiltration-guard`, etc.) are rejected
   * earlier by the manifest loader and never reach this field.
   */
  readonly manifestMiddleware?: readonly ManifestMiddlewareEntry[] | undefined;
  /**
   * Registry used to resolve `manifestMiddleware` entry names to
   * concrete factories. When omitted, the factory constructs
   * `createBuiltinManifestRegistry({allowFileBackedSinks: config.allowManifestFileSinks})`.
   * Pass `createDefaultManifestRegistry()` for an empty registry
   * when you want full control over the available names (useful
   * for tests or plugins), or pass a custom populated registry to
   * register host-specific factories.
   */
  readonly middlewareRegistry?: MiddlewareRegistry | undefined;
  /**
   * Host-controlled opt-in for file-backed manifest middleware
   * (currently only `@koi/middleware-audit`, which creates an
   * NDJSON sink at resolution time). Default: `false`.
   *
   * When `false`, the default built-in registry does NOT register
   * `@koi/middleware-audit`, so manifest entries naming it throw
   * `UnknownManifestMiddlewareError`. When `true`, the audit
   * middleware is available subject to path validation.
   *
   * Repo-authored `koi.yaml` cannot flip this flag — it is passed
   * programmatically by the host (CLI flag, env var, or
   * out-of-band policy). Letting committed manifests trigger
   * filesystem side effects is a trust-boundary regression we
   * deliberately avoid.
   */
  readonly allowManifestFileSinks?: boolean | undefined;
  /**
   * Host capability flag consumed by the required-middleware
   * enforcer. Terminal-capable runtimes (e.g. `koi tui`, `koi
   * start`) ship interactive shell / bash / web_fetch and must
   * boot with the full security baseline: `hooks`, `permissions`,
   * `exfiltration-guard`. Headless / CI runtimes (analysis agents,
   * programmatic embedders) only require `hooks` and may omit
   * the terminal-only layers.
   *
   * Defaults to `true` — the conservative posture that matches
   * the existing terminal hosts. Embedders assembling a headless
   * runtime pass `false` explicitly, and the enforcer relaxes
   * the baseline accordingly.
   */
  readonly terminalCapable?: boolean | undefined;
  /**
   * Engine loop-detection override. Passed verbatim to `createKoi`.
   *
   * - `undefined` (default) → the engine's default detector runs,
   *   bounding runaway tool-call spirals per `runTurn` invocation.
   *   This is the correct posture for `koi start` where the auto-
   *   allow permission backend doesn't gate repeated side-effecting
   *   retries interactively.
   * - `false` → disables detection entirely. `koi tui` opts in
   *   because its per-submit iteration budget reset
   *   (`resetBudgetPerRun: true` below, combined with the
   *   governance caps) already bounds spirals and false positives
   *   are expensive inside an interactive session.
   * - `Partial<LoopDetectionConfig>` → custom thresholds for hosts
   *   that need finer-grained tuning.
   */
  readonly loopDetection?: false | Partial<import("@koi/engine").LoopDetectionConfig> | undefined;
  /**
   * When `false`, the execution preset stack skips the
   * `bash_background` provider (detached shell subprocesses). The
   * core `Bash` tool and the full `task_*` tool set (task_create,
   * task_list, task_delegate, task_output, task_stop) stay wired
   * regardless, because spawned coordinator agents depend on
   * task-board orchestration for fan-out/result-collection flows
   * that don't involve background shell subprocesses.
   *
   * `koi start` passes `false` because its auto-allow permission
   * backend + the engine's default loop detector trip on legitimate
   * `task_output` polling of long-running `bash_background` jobs,
   * and the cleanest resolution is to not expose detached
   * subprocesses on the CLI at all. `koi tui` leaves this at the
   * default (true) because its interactive surface makes
   * long-running background work observable. Defaults to `true`.
   */
  readonly backgroundSubprocesses?: boolean | undefined;
  /**
   * Observer for spawn lifecycle events emitted by the Spawn tool executor.
   * The TUI bridge hooks this to dispatch spawn_requested and agent_status_changed
   * EngineEvents into the store so /agents and inline spawn_call blocks update.
   */
  readonly onSpawnEvent?:
    | ((event: {
        readonly kind: "spawn_requested" | "agent_status_changed";
        readonly agentId: string;
        readonly agentName: string;
        readonly description: string;
        readonly status?: "running" | "complete" | "failed";
      }) => void)
    | undefined;
  /** Working directory for file tools (Glob, fs_read, Bash). Defaults to process.cwd(). */
  readonly cwd?: string | undefined;
  /**
   * Absolute path to a settings file loaded as the `flag` layer — highest priority
   * below `policy`. Enables per-invocation overrides via `--settings <path>`.
   * When omitted the flag layer is empty (no per-invocation override).
   */
  readonly settingsFlagPath?: string | undefined;
  /**
   * System prompt injected via createSystemPromptMiddleware.
   * Tells the model it has tools and should use them.
   * When omitted, no system prompt middleware is installed.
   */
  readonly systemPrompt?: string | undefined;
  /**
   * Session transcript config for JSONL recording + session resume.
   * When omitted, no session transcript middleware is installed.
   */
  readonly session?:
    | {
        readonly transcript: SessionTranscript;
        readonly sessionId: SessionId;
      }
    | undefined;
  /**
   * Optional SkillsRuntime for MCP bridge integration.
   * When provided and .mcp.json exists, MCP tools are registered as skills
   * via createSkillsMcpBridge.
   */
  readonly skillsRuntime?: SkillsRuntime | undefined;
  /**
   * Persistent approval store for cross-session "always" grants.
   * When provided, durable approvals survive process restart.
   */
  readonly persistentApprovals?: ApprovalStore | undefined;
  /**
   * Pre-constructed current-model override middleware. When provided, runs
   * OUTER of `modelRouterMiddleware` and rewrites `request.model` to the
   * host-owned mutable box's current value. Used by the TUI to implement
   * mid-session model switching without rebuilding the runtime.
   */
  readonly currentModelMiddleware?: KoiMiddleware | undefined;
  /**
   * Optional getter invoked per turn to resolve the active model id. When set,
   * the transcript adapter resolves its `budgetConfig` via
   * `budgetConfigForModel(getCurrentModel())` on every turn so a mid-session
   * model switch picks up the new context-window limit immediately. When
   * absent, budget is sized once from `config.modelName`.
   *
   * Return `{ model, contextLength? }`. `contextLength` overrides the
   * model registry's default window — needed for switched-to models that
   * aren't in the local registry; the picker knows the window from the
   * provider's `/models` response.
   */
  readonly getCurrentModel?: () =>
    | string
    | { readonly model: string; readonly contextLength?: number | undefined };
  /**
   * Pre-constructed model-router middleware. When provided, routes all model
   * calls through the failover chain before reaching the model adapter.
   * Create via: createModelRouterMiddleware(createModelRouter(config, adapters))
   * When omitted, calls go directly to the model adapter (no routing/fallback).
   */
  readonly modelRouterMiddleware?: KoiMiddleware | undefined;
  /**
   * OpenTelemetry middleware config.
   *
   * - `true`  — enable with defaults (tracerName "@koi/middleware-otel", no content capture)
   * - `false` / omitted — disabled
   * - `OtelMiddlewareConfig` — fully customised (meter, tracerName, captureContent, onSpanError)
   *
   * Requires an OTel SDK to be initialised before `createTuiRuntime` is called.
   * In the CLI, set `KOI_OTEL_ENABLED=true` to opt in.
   *
   * @example
   *   otel: true
   * @example
   *   otel: { captureContent: true, meter: myMeter }
   */
  readonly otel?: OtelMiddlewareConfig | true | false | undefined;

  /**
   * Opt-in security-grade audit logging via `@koi/middleware-audit` +
   * `@koi/audit-sink-ndjson`. When set, every model/tool call is recorded
   * as a hash-chained NDJSON entry at this path.
   *
   * The TUI surfaces this via the `KOI_AUDIT_NDJSON` environment variable
   * — set to an absolute file path before launching `koi tui`. Any
   * existing file is appended to. Sink resources (writer, timer) are
   * owned by the runtime and closed during shutdown.
   */
  readonly auditNdjsonPath?: string | undefined;
  /**
   * Optional absolute path to a SQLite audit database file.
   *
   * The TUI surfaces this via the `KOI_AUDIT_SQLITE` environment variable
   * — set to an absolute file path before launching `koi tui`. The file
   * is created if it doesn't exist. Sink resources (WAL, timer) are
   * owned by the runtime and closed during shutdown.
   */
  readonly auditSqlitePath?: string | undefined;
  /** Path to the SQLite DB backing the ViolationStore.
   *  - `undefined` (default): auto-wires to `~/.koi/violations.db` when
   *    governance is enabled — mirrors the `~/.koi/governance-alerts.jsonl`
   *    convention from gov-9 so `/governance` history works out of the box.
   *  - Non-empty string: explicit override path.
   *  - Empty string `""`: disables the store entirely (violations only
   *    surfaced in-memory via the governance bridge for the current session). */
  readonly violationSqlitePath?: string | undefined;
  /**
   * Per-sink manifest provenance — set to the manifest file path when the
   * corresponding audit path was derived from `manifest.audit.*` (not from an
   * operator env var). `createKoiRuntime` calls `revalidateAuditPathContainment`
   * immediately before opening each manifest-derived sink to narrow the TOCTOU
   * window between the pre-runtime check in `tui-command.ts` and the actual
   * filesystem open syscall.
   *
   * A residual race remains because Bun/Node do not expose `openat` /
   * `O_NOFOLLOW` for intermediate path components — full atomicity would require
   * L2 sink API changes. The narrowed window is the best-effort mitigation.
   *
   * Leave each field `undefined` for env-var-sourced paths: those are operator-
   * trusted and are NOT subject to manifest containment revalidation.
   */
  readonly manifestNdjsonSourcePath?: string | undefined;
  readonly manifestSqliteSourcePath?: string | undefined;
  readonly manifestViolationsSourcePath?: string | undefined;
  /**
   * Opt-in: activate `@koi/middleware-report` to emit a RunReport at
   * session end. The TUI surfaces this via `KOI_REPORT_ENABLED=true`.
   */
  readonly reportEnabled?: boolean | undefined;
  /**
   * Opt-in: activate `@koi/middleware-planning` and its `write_plan`
   * tool. Default `false`: plan state is currently ephemeral
   * (no durable persistence across resume/restart), so enabling by
   * default in resume-capable hosts would silently lose plan state
   * after `koi tui --resume`. Hosts that accept the ephemerality can
   * set this to `true`; durable persistence is tracked as issue
   * #1842 (file-backed plan persistence) and will make this flag a
   * no-op default when it lands.
   */
  readonly planningEnabled?: boolean | undefined;
  /**
   * Opt-in: activate `@koi/middleware-feedback-loop` for model-response
   * validation and tool-health tracking. When set, the middleware is wired
   * into the outer middleware zone alongside the audit/report middlewares.
   * Surface via `KOI_FEEDBACK_LOOP_ENABLED=true` in the TUI, which
   * activates the middleware with an empty config (no validators, no
   * quarantine thresholds — observe-only posture).
   */
  readonly feedbackLoop?: FeedbackLoopConfig | undefined;
  /**
   * Subset of filesystem operations to expose (#1777). `undefined`
   * means "all three" (`fs_read`/`fs_write`/`fs_edit`). Hosts that
   * honor a `manifest.filesystem.operations` gate pass the resolved
   * list through here. Honored by `buildCoreProviders`.
   */
  readonly filesystemOperations?: readonly ("read" | "write" | "edit")[] | undefined;
  /**
   * Active filesystem backend to use for `fs_read`, `fs_write`, and
   * `fs_edit` tools, AND for the checkpoint preset stack's backend
   * discriminator (capture + rewind dispatch).
   *
   * When omitted, the factory creates a default `@koi/fs-local` backend
   * rooted at `cwd` with `allowExternalPaths: true` — the same backend
   * `buildCoreProviders` previously created internally. Pass an explicit
   * backend here when the session uses a non-local filesystem (e.g.
   * Nexus via `resolveFileSystemAsync`) so the checkpoint middleware
   * stamps the correct backend name on `FileOpRecord` entries and the
   * restore protocol can dispatch compensating ops through the right
   * backend during rewind.
   */
  readonly filesystem?: FileSystemBackend | undefined;
  /**
   * Host-provided ComponentProviders appended after the core + stack
   * providers and before plan-related providers. Used to wire host-owned
   * subsystems that don't fit a preset stack (e.g. `@koi/artifacts`
   * tools backed by a host-owned ArtifactStore). Order preserved.
   */
  readonly extraProviders?: readonly ComponentProvider[] | undefined;
}

export interface KoiRuntimeHandle {
  /** The assembled KoiRuntime — call runtime.run(input) to stream a turn. */
  readonly runtime: KoiRuntime;
  /**
   * Checkpoint handle for session-level rollback (#1625). Always populated
   * in the TUI — captures end-of-turn snapshots and exposes rewind() so the
   * `/rewind` slash command can roll back the active session.
   *
   * Snapshots live in an in-memory SQLite chain (per-process, lost on exit);
   * blobs live in a flat tmp dir under `~/.koi/file-history`. The conversation
   * log is shared with the session transcript so /rewind truncates both halves.
   */
  /**
   * Checkpoint handle for session-level rollback — populated when the
   * `checkpoint` preset stack is active (default) and `undefined` when
   * a host disables it via `manifest.stacks`. Hosts that consume this
   * field guard with `?.rewind(...)` so a disabled stack degrades to
   * "/rewind unsupported" rather than a crash.
   */
  readonly checkpoint: Checkpoint | undefined;
  /**
   * Mutable conversation transcript array — owned by the caller.
   * Splice to reset: `transcript.splice(0)` on agent:clear or session:new.
   */
  readonly transcript: InboundMessage[];
  /**
   * Retrieve the current session's ATIF trajectory steps (last MAX_TRAJECTORY_STEPS).
   *
   * Data source: in-memory event-trace store — no disk I/O.
   * Used by the /trajectory TUI command.
   */
  readonly getTrajectorySteps: () => Promise<readonly RichTrajectoryStep[]>;
  /**
   * Append a pre-built trajectory step to the session's ATIF document. Used
   * by non-engine code paths that still deserve to appear in /trajectory —
   * notably `/rewind`, which runs `checkpoint.rewind()` directly without
   * going through `runTurn`, so the trace wrapper never sees it.
   */
  readonly appendTrajectoryStep: (step: RichTrajectoryStep) => Promise<void>;
  /**
   * Reset stateful tool state for a new session (agent:clear / session:new).
   *
   * @param signal — the active run's AbortSignal. Must already be aborted
   * (`signal.aborted === true`). Enforced at runtime — throws if the caller
   * forgot to abort the controller before resetting session state.
   *
   * Aborting first ensures all in-flight tool calls are cancelled before
   * the board pointer moves, closing the window where a tool call could observe
   * the old board via `add`/`assign` and then the new board via `complete`/`fail`.
   *
   * 1. Resets the Bash tool's tracked cwd to workspace root.
   * 2. Aborts prior-session background subprocesses (SIGTERM → SIGKILL) and
   *    rotates the AbortController so new tasks use a fresh signal.
   * 3. Rotates the task board to a fresh in-memory instance — prior-session tasks
   *    are abandoned with the old board and not discoverable via task_list /
   *    task_get / task_output in the new session.
   * 4. Clears session-scoped approval state (always-allow, approval cache, denial
   *    trackers) so prior-session approvals do not silently carry into the new session.
   * 5. Clears the in-memory trajectory store for the new session.
   */
  readonly resetSessionState: (
    signal: AbortSignal,
    options?: { readonly truncate?: boolean },
  ) => Promise<void>;
  /**
   * Abort all in-flight bash_background subprocesses (SIGTERM → SIGKILL).
   *
   * Call before `runtime.dispose()` on shutdown (SIGINT/SIGTERM/system:quit) so
   * background commands don't outlive the process as orphaned OS subprocesses.
   *
   * If this returns `true` (tasks were in-flight), wait at least
   * `SIGKILL_ESCALATION_MS + 200` ms before calling `process.exit()` to allow
   * the SIGTERM → SIGKILL escalation timers to fire. Exiting before SIGKILL
   * cancels those timers, leaving subprocesses that ignore SIGTERM as orphans.
   */
  readonly shutdownBackgroundTasks: () => boolean;
  /**
   * Returns true if any background subprocesses are currently in-flight.
   *
   * Uses the authoritative live-subprocess counter from `onSubprocessStart`/
   * `onSubprocessEnd` callbacks — not task-board state, which can diverge
   * when `task_stop` changes board state without terminating the OS process.
   *
   * Check immediately before `shutdownBackgroundTasks()` to determine whether
   * to wait for the SIGKILL escalation window before `process.exit()`.
   */
  readonly hasActiveBackgroundTasks: () => boolean;
  /**
   * True if the OS sandbox adapter (seatbelt / bwrap) was successfully initialised.
   *
   * When false, Bash and bash_background run without OS-level filesystem confinement —
   * only the @koi/bash-security denylist guard applies. Surface a warning to the user
   * in the TUI so they are aware of the reduced isolation posture.
   */
  readonly sandboxActive: boolean;
  /**
   * #1862: Formatted run-report text buffered by onSessionEnd. Non-empty
   * when KOI_REPORT_ENABLED=true and onSessionEnd completed. The TUI
   * prints this after appHandle.stop() releases the alt screen so the
   * output is visible on the main screen.
   */
  readonly getPendingReport: () => string | undefined;
  /**
   * Decision ledger factory — creates a per-session ledger reader backed by
   * the in-memory trajectory store. Used by the /trajectory view to show
   * audit entries and source status alongside trajectory steps.
   */
  readonly createDecisionLedger: () => DecisionLedgerReader;
  /**
   * MCP server status — returns configured servers, their connection states,
   * and tool counts. Used by the `/mcp` TUI command. Returns empty array when
   * no MCP servers are configured.
   */
  readonly getMcpStatus: () => Promise<readonly McpServerStatus[]>;
  /**
   * Plugin discovery summary — loaded plugins + any errors.
   * Static for the lifetime of the runtime. Used by the TUI to populate
   * the /plugins view and inject plugin awareness into the system prompt.
   */
  readonly pluginSummary: PluginDiscoverySummary;
  /**
   * Static snapshot of governance backend rules for the `/governance` "Active
   * rules" section. Resolved once at runtime construction via
   * `backend.describeRules()`; falls back to a synthetic `default-allow`
   * descriptor when the backend reports no rules. Empty rule lists never
   * surface — callers always receive at least one descriptor.
   */
  readonly governanceRules: readonly RuleDescriptor[];
  /**
   * Resolved alert threshold fractions (e.g. `[0.7, 0.9]`) — CLI flags >
   * manifest > undefined. Hosts (TUI governance bridge) that emit their own
   * alert toasts must honor these rather than hardcoding their own set, so
   * `--alert-threshold` precedence is authoritative across every alerting
   * path. Undefined means the host should use its observational default.
   */
  readonly governanceAlertThresholds: readonly number[] | undefined;
  /**
   * Mirrors `config.governanceDisabled !== true`. Hosts must consult this
   * before wiring their own observer surfaces (bridge, alerts JSONL, UI
   * panels): even when the engine's bundled GOVERNANCE component is still
   * present under `--no-governance` (to keep guard-level safety on), the
   * HOST-level alerting/persistence layer must stay off. Without this gate
   * `--no-governance` fails open on the TUI toast + alerts-file paths.
   */
  readonly governanceEnabled: boolean;
  /**
   * Optional SQLite violation store — present when `config.violationSqlitePath`
   * is set. Passed to `createGovernanceBridge` so the TUI governance view can
   * query recent persisted violations via `bridge.loadRecentViolations()`.
   * Undefined when violations persistence is not configured.
   */
  readonly violationStore: ViolationStore | undefined;
  /**
   * The assembled governance backend — present when governance is enabled
   * (`governanceEnabled === true`). Exposes `.compliance` (ComplianceRecorder)
   * when `auditSqlitePath` is set, and `.violations` (ViolationStore) when
   * `violationSqlitePath` is set. Undefined when `governanceDisabled: true`.
   *
   * Integration tests use this field to verify wiring without synthesising
   * a full verdict (Task 13 / #1393).
   */
  readonly governanceBackend: GovernanceBackend | undefined;
}

/** Status entry for a single MCP server (used by /mcp TUI command). */
export interface McpServerStatus {
  readonly name: string;
  readonly toolCount: number;
  readonly failureCode: string | undefined;
  readonly failureMessage: string | undefined;
  /** Transport kind — undefined for plugin-provided servers where config is unavailable. */
  readonly transport: "http" | "stdio" | "sse" | undefined;
  /** Whether this server has a usable OAuth config — `needs-auth` is only valid when true. */
  readonly hasOAuth: boolean;
}

// MCP loading has moved to `./shared-wiring.ts` — both `koi start` and
// `koi tui` now call `loadUserMcpSetup` / `buildPluginMcpSetup` from there
// so the `.mcp.json` discovery + SkillsMcpBridge logic lives in one place.

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface ConfigHotReloadHandle {
  readonly dispose: () => void;
}

/**
 * Optional config hot-reload wiring for `@koi/config` (issue #1632).
 *
 * Guarded by the `KOI_CONFIG_PATH` env var — if unset, this is a no-op
 * and nothing changes from the pre-existing TUI behavior. When set to a
 * config file path, instantiates a `ConfigManager`, calls `initialize()`,
 * starts `watch()`, and registers a consumer that logs every reload
 * event to stderr.
 *
 * **This consumer is intentionally log-only.** The TUI does not currently
 * hot-swap any config fields into a running `createKoi` session — that
 * requires `createKoi` to support rebuilding the runtime on reset, which
 * is tracked as a known limitation elsewhere in this file (see the
 * `resetSessionState` comment). The wiring exists to:
 *
 *   1. Smoke-test `@koi/config`'s hot-reload primitives in a real
 *      long-running process, not just in unit tests.
 *   2. Serve as canonical example wiring for downstream consumers (tool
 *      registries, permission evaluators, prompt manifests) that the
 *      follow-up PRs to #1632 will eventually add.
 *   3. Give operators visibility: if they set `KOI_CONFIG_PATH` and edit
 *      the file, they'll see stderr log lines confirming the reload
 *      pipeline fired.
 *
 * Watcher errors and consumer errors are logged through the dedicated
 * `onWatcherError` / `onConsumerError` callbacks so they don't
 * conflate with the regular reload lifecycle events.
 */
async function setupConfigHotReload(): Promise<ConfigHotReloadHandle | undefined> {
  const configPath = process.env.KOI_CONFIG_PATH;
  if (configPath === undefined || configPath === "") return undefined;

  // Optional post-startup visibility: once OpenTUI takes over the terminal,
  // `console.error`/`process.stderr.write` output is buffered and not
  // visible to the user. If the operator wants to observe live reload
  // events during an interactive session, they set KOI_CONFIG_LOG_PATH to
  // a file path and this consumer appends every event there. Startup
  // events (before the TUI renders) are always visible on stderr regardless.
  const logPath = process.env.KOI_CONFIG_LOG_PATH;
  const fileLog = (msg: string): void => {
    if (logPath === undefined || logPath === "") return;
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* swallow — never let a failing log sink break the pipeline */
    }
  };

  const mgr = createConfigManager({
    filePath: configPath,
    onConsumerError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      fileLog(`consumer-failed: ${msg}`);
      console.error(`[koi tui] config consumer failed: ${msg}`);
    },
    onWatcherError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      fileLog(`watcher-error: ${msg}`);
      console.error(`[koi tui] config watcher error: ${msg}`);
    },
  });

  mgr.events.subscribe((event) => {
    // Telemetry fan-out: rejected reloads are always surfaced; applied
    // events are logged to the file sink only when non-empty (spurious
    // fs.watch fires with no real change are too noisy).
    if (event.kind === "rejected") {
      fileLog(`rejected reason=${event.reason} error=${event.error.message}`);
      console.error(`[koi tui] config reload rejected (${event.reason}): ${event.error.message}`);
    } else if (event.kind === "applied" && event.changedPaths.length > 0) {
      fileLog(`applied paths=[${event.changedPaths.join(",")}]`);
    }
  });

  mgr.registerConsumer({
    onConfigChange: ({ changedPaths, prev, next }) => {
      // Log-only consumer. The TUI runtime does not hot-swap config
      // fields into the running session — `createKoi` does not support
      // runtime re-assembly yet (tracked as a known limitation at
      // `resetSessionState` below). For now we log the change so
      // operators can verify the pipeline fires, and the primitive is
      // ready to plug into real consumers in follow-up PRs.
      fileLog(
        `changed paths=[${changedPaths.join(",")}] logLevel=${prev.logLevel}→${next.logLevel}`,
      );
      console.error(
        `[koi tui] config changed [${changedPaths.join(", ")}] ` +
          `logLevel=${prev.logLevel}→${next.logLevel}`,
      );
    },
  });

  fileLog(`setup configPath=${configPath} pid=${process.pid}`);
  const initResult = await mgr.initialize();
  if (initResult.ok) {
    fileLog("initialize ok");
    console.error(`[koi tui] config hot-reload armed on ${configPath}`);
  } else {
    // Initialize failed (file missing, invalid, etc.). The manager's
    // watcher is still armed — when the file is created or fixed, the
    // next onFileEvent retries initialize() automatically. No need to
    // fail TUI startup.
    fileLog(`initialize failed: ${initResult.error.code} ${initResult.error.message}`);
    console.error(
      `[koi tui] config initialize failed (${initResult.error.code}): ${initResult.error.message}`,
    );
  }
  const unsub = mgr.watch();
  fileLog("watcher armed");

  return {
    dispose: () => {
      fileLog("dispose");
      unsub();
      mgr.dispose();
    },
  };
}

/**
 * Assemble the full L2 tool stack via createKoi. This is the shared
 * runtime factory for every host — `koi tui`, `koi start`, and any
 * future frontend. Hosts differ only in their I/O loop and a handful
 * of config knobs (permission backend, approval handler, spawn event
 * hook, persistent approvals). The runtime, middleware stack, and
 * provider set are all identical across hosts so adding a feature in
 * one place lands in every frontend automatically.
 *
 * Blueprint: record-cassettes.ts — this is the same composition used in
 * golden query recording. MCP loaded from .mcp.json when present.
 *
 * **IMPORTANT — default behavior for optional fields (read before
 * calling this from a new host):**
 *
 * - `loopDetection` — when omitted, the engine's default detector is
 *   enabled. This is a semantic change from the pre-refactor behavior
 *   where the factory hard-disabled loop detection unconditionally.
 *   Hosts that rely on detection being OFF (e.g. `koi tui` where
 *   interactive false-positives are expensive) MUST pass
 *   `loopDetection: false` explicitly.
 * - `backgroundSubprocesses` — when omitted, defaults to `true`
 *   (execution stack contributes the `bash_background` tool). Hosts
 *   that want a narrower tool surface (e.g. `koi start` with auto-
 *   allow permissions) MUST pass `backgroundSubprocesses: false`
 *   explicitly. The `task_*` tool set stays wired regardless.
 *
 * Both known call sites (`koi start` in `commands/start.ts` and
 * `koi tui` in `tui-command.ts`) pass explicit values for these two
 * fields. The test harness in `runtime-factory.test.ts` exercises
 * the factory via mock adapters and does not rely on the defaults.
 * If you add a new caller, pass both fields explicitly and document
 * the chosen posture.
 */
const DEFAULT_MAX_DURATION_MS = 1_800_000;
/** Track the last invalid KOI_MAX_DURATION_MS we warned about so we
 * don't spam the console across hot-reload / repeated factory calls. */
// let justified: module-scoped memo for the diagnostic emitter.
let lastWarnedInvalidEnv: string | undefined;
// Node's setTimeout clamps delays above 2^31-1 to 1ms (emits
// TimeoutOverflowWarning). The iteration guard passes `maxDurationMs`
// directly into setTimeout, so any "effectively unlimited" sentinel
// must stay within int32 range. 2^31-1 ms ≈ 24.8 days — well beyond
// any realistic turn duration.
const MAX_SETTIMEOUT_SAFE_MS = 2_147_483_647;

// Strict unsigned-integer form. Rejects zero-equivalent aliases like
// `"00"`, `"+0"`, `"-0"`, `"0.0"`, `"0e0"` — all of which Number()
// coerces to 0 and would otherwise flip the cap off via the
// `n === 0` branch.
const UNSIGNED_INT_RE = /^(0|[1-9]\d*)$/;

/** @internal — exported for unit tests only; not part of the public API. */
export function resolveMaxDurationMs(hostDefault?: number): number {
  const fallback = hostDefault ?? DEFAULT_MAX_DURATION_MS;
  const raw = process.env.KOI_MAX_DURATION_MS;
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  // Strict parse: `Number("")` returns 0 and Number("00") also returns 0,
  // either of which would flip the cap off silently. Require the raw
  // string to match an unsigned decimal integer before trusting it.
  if (!UNSIGNED_INT_RE.test(trimmed)) {
    // Diagnostic: operator-supplied but unparseable. Warn once per
    // distinct raw value so mistakes are visible without log spam.
    if (lastWarnedInvalidEnv !== raw) {
      lastWarnedInvalidEnv = raw;
      console.warn(
        `[koi] ignoring KOI_MAX_DURATION_MS=${JSON.stringify(raw)}: ` +
          "expected an unsigned decimal integer (ms) or '0' to disable. " +
          `Using default ${fallback}ms.`,
      );
    }
    return fallback;
  }
  if (trimmed === "0") return MAX_SETTIMEOUT_SAFE_MS;
  const n = Number(trimmed);
  return Math.min(n, MAX_SETTIMEOUT_SAFE_MS);
}

/**
 * Thrown when the policy settings file fails to parse or load.
 * `start.ts` catches this specifically to emit `bail(msg, 2)` — the documented
 * policy-failure exit code — instead of a generic runtime-assembly error.
 */
export class PolicyLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyLoadError";
  }
}

export async function createKoiRuntime(config: KoiRuntimeConfig): Promise<KoiRuntimeHandle> {
  const {
    modelAdapter,
    modelName,
    approvalHandler,
    cwd = process.cwd(),
    settingsFlagPath,
    skillsRuntime,
  } = config;
  // Stable host identifier — used as the persistentAgentId for permissions,
  // the agentName in trajectory metadata, and the [koi/X] log prefix.
  // Pulled up from below so preset stack activation (which runs early so
  // stacks can contribute hookExtras before the hook middleware is built)
  // can thread it into the StackActivationContext.
  const hostId = config.hostId ?? "koi-tui";

  // --- Optional config hot-reload (log-only; guarded by KOI_CONFIG_PATH) ---
  const configHotReload = await setupConfigHotReload();

  // --- Plugin activation: load enabled plugins' hooks, MCP, skills ---
  // Stays inline because it feeds BOTH the pre-stack hook merge AND
  // the MCP stack's server list — it's host bootstrap, not a
  // feature bundle. The MCP preset stack consumes its outputs via
  // `ctx.host[PLUGIN_MCP_SERVERS_HOST_KEY]`.
  const pluginUserRoot = join(homedir(), ".koi", "plugins");
  const pluginComponents = await loadPluginComponents(
    pluginUserRoot,
    config.plugins !== undefined ? { allowlist: new Set(config.plugins) } : undefined,
  );
  if (pluginComponents.errors.length > 0) {
    for (const err of pluginComponents.errors) {
      console.warn(`[koi/${hostId}] plugin "${err.plugin}": ${err.error}`);
    }
  }
  if (pluginComponents.middlewareNames.length > 0) {
    console.warn(
      `[koi/${hostId}] ${String(pluginComponents.middlewareNames.length)} plugin middleware name(s) skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
    );
  }

  // Register plugin skills with the SkillsRuntime (if any)
  if (skillsRuntime !== undefined && pluginComponents.skillMetadata.length > 0) {
    skillsRuntime.registerExternal(pluginComponents.skillMetadata);
  }

  // Surface skipped middleware as a warning in the plugin summary so
  // /plugins shows it, but don't block the plugin's other components.
  const middlewareWarnings =
    pluginComponents.middlewareNames.length > 0
      ? [
          {
            plugin: "(middleware)",
            error: `Skipped (no factory registry): ${pluginComponents.middlewareNames.join(", ")}`,
          },
        ]
      : [];
  const pluginSummary: PluginDiscoverySummary = {
    loaded: pluginComponents.discovered,
    errors: [...pluginComponents.errors, ...middlewareWarnings],
  };
  // #1887: suppress the "N plugin(s) loaded" line for `koi tui`. The
  // TUI's alt-screen immediately covers pre-launch stderr, so the line
  // only flashes briefly and then sits as orphaned noise on the primary
  // screen after quit — symmetric with the in-TUI banner, which is now
  // also suppressed on clean loads. Other hosts (koi start, scripts,
  // other bins) still get the line so their plain-terminal output shows
  // which plugins loaded. Errors are logged unconditionally above.
  if (pluginSummary.loaded.length > 0 && hostId !== "koi-tui") {
    // Sanitize plugin-derived strings before logging to prevent terminal
    // control sequence injection from malicious plugin manifests.
    // biome-ignore lint/complexity/useRegexLiterals: control chars require RegExp constructor
    const ANSI_LOG_RE = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
    // biome-ignore lint/complexity/useRegexLiterals: control chars require RegExp constructor
    const CTRL_LOG_RE = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
    const sanitizeLog = (s: string): string => s.replace(ANSI_LOG_RE, "").replace(CTRL_LOG_RE, "");
    const names = pluginSummary.loaded
      .map((p) => `${sanitizeLog(p.name)}@${sanitizeLog(p.version)}`)
      .join(", ");
    console.error(
      `[koi/${hostId}] ${String(pluginSummary.loaded.length)} plugin(s) loaded: ${names}`,
    );
  }

  // Session generation counter — incremented on each reset.
  // The trace wrapper and event-trace MW capture the doc ID at construction
  // and can't be rotated after createKoi assembly. The prune is awaited to
  // minimize the window, but late fire-and-forget appends from the old
  // session's trace can theoretically recreate the pruned document.
  // In practice this window is <1ms (prune completes before new submit).
  // Full fix requires doc-ID rotation which needs API changes to the trace
  // wrapper — tracked as a known limitation.

  // --- Preset stack activation (v1 `activatePresetStacks` pattern) ---
  // Two-phase activation so feature stacks with cross-cutting
  // dependencies (spawn needs already-composed middleware for child
  // inheritance) can compose cleanly:
  //
  //   Phase 1 (early, default) — runs BEFORE the core middleware is
  //     built. Early stacks can contribute `hookExtras.onExecuted`
  //     observer taps (observability) and export state the factory
  //     reads (bashHandle, trajectoryStore, checkpointHandle, etc.).
  //
  //   Phase 2 (late) — runs AFTER the core middleware is assembled.
  //     Late stacks read already-built middleware from `ctx.host`
  //     under `LATE_PHASE_HOST_KEYS`. Spawn is currently the only
  //     late-phase consumer — it needs permissions/hook/exfil/
  //     system-prompt for the child inheritance list.
  //
  // The execution stack needs a synthetic agent id for task
  // assignment and a reference to the caller's approval handler for
  // bash elicit. Both are passed via `ctx.host`.
  const precomputedAgentId = makeAgentId(hostId);
  const enabledStackIds = config.stacks !== undefined ? new Set(config.stacks) : undefined;
  // Determine whether the spawn preset stack is in the active set
  // for this host. When no explicit `config.stacks` list was given,
  // the factory activates every stack in `DEFAULT_STACKS` — so
  // spawn is on by default. When an explicit list IS given (e.g.
  // `koi start` passes `DEFAULT_STACKS_WITHOUT_SPAWN`), we check
  // for membership directly. The derived flag flows through into
  // the execution stack so task_* tools get wired IFF spawn is
  // active (coordinator surface is consistent with sub-agent
  // capability).
  const spawnStackActive = enabledStackIds === undefined || enabledStackIds.has("spawn");

  // Zone B + spawn used to be a fail-closed combination because
  // children would otherwise have shared the parent's mutable
  // middleware instances (audit queues, hash chains, session
  // lifecycle state). The spawn preset stack now accepts a
  // `perChildMiddlewareFactory` that re-resolves manifest
  // middleware fresh per child, so children get their own
  // per-session state without escaping manifest-enforced policy.
  // The factory itself is built and stashed below, after the
  // manifest registry is constructed.

  // `bash_background` depends on the task-board surface for job
  // status / output inspection. If the caller requested
  // `backgroundSubprocesses: true` but the spawn stack (which
  // gates task_*) is excluded, we have an incoherent
  // combination: the model could launch detached work but have
  // no supported way to read its output or detect completion.
  // Force-override to `false` and warn the operator so the
  // runtime assembles cleanly instead of booting into a broken
  // state. `koi start` rejects this combo earlier at manifest
  // validation, so only TUI manifests with a custom `stacks`
  // list hit this branch.
  const rawBackgroundSubprocesses = config.backgroundSubprocesses ?? true;
  const effectiveBackgroundSubprocesses = rawBackgroundSubprocesses && spawnStackActive;
  if (rawBackgroundSubprocesses && !spawnStackActive) {
    console.warn(
      `[koi/${hostId}] backgroundSubprocesses=true requires the spawn preset stack ` +
        "(for task_create / task_output / task_stop observability). spawn is not in " +
        "the active stack set — bash_background is being disabled automatically. " +
        "Either add 'spawn' to manifest.stacks or explicitly set " +
        "backgroundSubprocesses: false to silence this warning.",
    );
  }

  // --- Filesystem backend — shared by tools and the checkpoint stack ---
  // When the caller supplies an explicit filesystem backend (e.g. a Nexus
  // backend from resolveFileSystemAsync), use it; otherwise fall back to
  // the default local backend so the checkpoint stack receives the same
  // instance that fs_write / fs_edit tools use.
  //
  // The backend is passed into StackActivationContext.filesystem so the
  // checkpoint preset stack can:
  //   1. Stamp `FileOpRecord.backend` with the backend name during capture.
  //   2. Build the `backends` map for the restore protocol's rewind dispatch.
  //
  // For the default local backend (`name === "local"`), the checkpoint
  // stack skips both — the restore protocol treats absent/local ops as
  // direct local I/O, which is the existing behavior.
  // Headless runs lock the default local backend to workspace-only
  // semantics: with allowExternalPaths=true, a whitelisted `fs_read`
  // could resolve `/etc/passwd` or `../../secrets.env` and exfiltrate
  // CI-runner secrets. Headless's --allow-tool whitelist is meant to
  // contain tool ACCESS, not broaden filesystem scope. Interactive hosts
  // keep the relaxed default so operators can still reference files
  // outside the project during a REPL session.
  const filesystemBackend: FileSystemBackend =
    config.filesystem ??
    createLocalFileSystem(cwd, {
      allowExternalPaths: config.workspaceOnlyFs !== true,
    });

  const earlyContextHost: Record<string, unknown> = {
    ...(skillsRuntime !== undefined ? { skillsRuntime } : {}),
    ...(config.otel !== undefined ? { otelConfig: config.otel } : {}),
    approvalHandler,
    agentId: precomputedAgentId,
    modelName,
    pluginMcpServers: pluginComponents.mcpServers,
    // Effective flag: caller-requested AND spawn stack active. The
    // invariant is "bash_background requires the task-board
    // surface" and the factory enforces it here rather than
    // letting the execution stack assemble an unmanageable
    // background-job surface.
    backgroundSubprocesses: effectiveBackgroundSubprocesses,
    // Task-board tool surface tracks spawn-stack enablement: with
    // spawn active, coordinator flows need task_* wired; without,
    // the task surface is vestigial and would only create
    // detector false-positive exposure.
    taskBoardTools: spawnStackActive,
    ...(config.bashElicitAutoApprove === true ? { bashElicitAutoApprove: true } : {}),
    ...(config.onSpawnEvent !== undefined ? { onSpawnEvent: config.onSpawnEvent } : {}),
  };
  const earlyContext: import("./preset-stacks.js").StackActivationContext = {
    cwd,
    hostId,
    modelAdapter,
    filesystem: filesystemBackend,
    ...(config.session !== undefined ? { sessionTranscript: config.session.transcript } : {}),
    host: earlyContextHost,
  };
  const earlyContribution = await activateStacks(earlyContext, {
    phase: "early",
    ...(enabledStackIds !== undefined ? { enabled: enabledStackIds } : {}),
  });

  // --- Read observability exports for trace wrapping + handle fields ---
  // Reads from `earlyContribution` because the late phase hasn't run
  // yet — the late-phase merged `stackContribution` is built further
  // below, after the core middleware is assembled.
  const trajectoryStore = earlyContribution.exports.trajectoryStore as
    | import("@koi/core/rich-trajectory").TrajectoryDocumentStore
    | undefined;
  const trajectoryDocId =
    (earlyContribution.exports.trajectoryDocId as string | undefined) ?? "koi-session";

  // --- @koi/hooks: load hooks from ~/.koi/hooks.json + command hook dispatch ---
  // Same loader the CLI host uses, via ./shared-wiring.ts.
  // Absent/unreadable file = no hooks (empty array, middleware is a no-op).
  // Agent hooks (kind: "agent") are filtered out because the TUI does not
  // provide a spawnFn — createHookMiddleware throws if any agent hook is
  // present without one. Prompt hooks (kind: "prompt") are supported via a
  // lightweight PromptModelCaller that delegates to the TUI's model adapter
  // for single-shot verification.
  // Hooks gate: per-invocation config.disableUserHooks takes precedence,
  // falling back to the legacy KOI_DISABLE_HOOKS env var for callers that
  // haven't migrated yet. Per-invocation scoping means two runtimes in the
  // same process don't interfere — the env-mutation path was racy under
  // concurrent invocations (issue #1648 round 8).
  const hooksDisabled = config.disableUserHooks === true || process.env.KOI_DISABLE_HOOKS === "1";
  const loadedHooks = hooksDisabled
    ? []
    : await loadUserRegisteredHooks({
        filterAgentHooks: true,
        onAgentHooksFiltered: (names) => {
          console.warn(
            `[koi tui] ${names.length} agent hook(s) skipped (not supported in TUI): ${names.join(", ")}`,
          );
        },
        onLoadError: (message) => {
          // Per-entry loader errors: surface each so operators see which entry
          // broke the file instead of silently losing every hook (issue #1781).
          console.warn(`[koi tui] hooks.json: ${message}`);
        },
      });
  // Merge plugin hooks (session tier) with user hooks (user tier).
  // Plugin hooks run first within their tier; user hooks in the next tier phase.
  const allHooks = mergeUserAndPluginHooks(loadedHooks, pluginComponents.hooks, {
    filterAgentHooks: true,
    onFilteredAgentHooks: (names) => {
      console.warn(
        `[koi tui] ${names.length} plugin agent hook(s) skipped (not supported in TUI): ${names.join(", ")}`,
      );
    },
  });

  // Lightweight PromptModelCaller — delegates to the TUI's model adapter for
  // single-shot LLM verification. Builds a minimal ModelRequest with the
  // verification prompt as a user message and the system prompt in the
  // trusted systemPrompt field.
  const promptCallFn: PromptModelCaller = {
    complete: async (req) => {
      const userMessage: InboundMessage = {
        content: [{ kind: "text", text: req.userPrompt }],
        senderId: "hook-prompt",
        timestamp: Date.now(),
      };
      const response = await modelAdapter.complete({
        messages: [userMessage],
        model: req.model,
        maxTokens: req.maxTokens,
        systemPrompt: req.systemPrompt,
        signal: AbortSignal.timeout(req.timeoutMs),
        tools: [], // No tools for single-shot verification
      });
      return { text: response.content };
    },
  };

  const hasPromptHooks = allHooks.some((rh) => rh.hook.kind === "prompt");
  // Hook middleware is built below via `buildCoreMiddleware` (the
  // shared slot factory). Declaring it here would duplicate the
  // construction — the downstream `allMiddleware` array reads
  // `coreSlots.hook` instead.

  // --- @koi/permissions + @koi/middleware-permissions ---
  // Always load settings — policy-layer rules must be enforced on every startup
  // path, including koi start which supplies its own custom backend.
  // Non-policy parse/schema errors are logged and skipped (fail-open for user
  // layers); a policy-layer error is re-thrown so the top-level handler can
  // exit with the fail-closed error code rather than produce a generic crash.
  const settingsRules: SourcedRule[] = [];
  const settingsDefaultMode = "default" as const;
  try {
    const { sources, errors: settingsErrors } = await loadSettings({
      cwd,
      ...(settingsFlagPath !== undefined ? { flagPath: settingsFlagPath } : {}),
    });
    for (const err of settingsErrors) {
      console.warn(`[koi/${hostId}] settings validation warning: ${err.file}: ${err.message}`);
    }
    for (const source of SOURCE_PRECEDENCE) {
      const layerSettings = sources[source];
      if (layerSettings != null) {
        const rules = mapSettingsToSourcedRules(layerSettings, source);
        // Policy layer is tightening-only: allow entries are dropped to prevent
        // policy from re-opening tools that lower-precedence layers deny.
        const filtered = source === "policy" ? rules.filter((r) => r.effect !== "allow") : rules;
        settingsRules.push(...filtered);
      }
    }
  } catch (err) {
    // Policy or explicit --settings file is malformed or unreadable — rethrow
    // so the caller can exit with code 2 (fail-closed).
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolicyLoadError(`[koi/${hostId}] fatal: settings failed to load — ${msg}`, {
      cause: err,
    });
  }

  // Sort helpers: highest-precedence source first, then deny < ask < allow.
  const EFFECT_ORDER: Readonly<Record<string, number>> = { deny: 0, ask: 1, allow: 2 };
  const precedenceIdx = (r: SourcedRule): number => SOURCE_PRECEDENCE.indexOf(r.source);
  const sortRules = (rules: readonly SourcedRule[]): readonly SourcedRule[] =>
    [...rules].sort((a, b) => {
      const srcDiff = precedenceIdx(a) - precedenceIdx(b);
      if (srcDiff !== 0) return srcDiff;
      return (EFFECT_ORDER[a.effect] ?? 3) - (EFFECT_ORDER[b.effect] ?? 3);
    });

  // Build the permission backend:
  //   Custom backend path (koi start): enforce policy-layer rules first, then
  //     delegate to the caller's marker-aware backend.  No widening needed —
  //     the custom backend evaluates enriched command-scoped resources directly.
  //   TUI path: widen command-scoped rules fail-closed (the TUI backend only
  //     receives plain tool ids), then add built-in TUI allows as fallback.
  let permBackend: PermissionBackend;
  if (config.permissionBackend !== undefined) {
    const inner = config.permissionBackend;
    // Settings may only TIGHTEN on the custom-backend path (koi start).
    // Allow rules would bypass the caller's explicit whitelist (e.g. --allow-tool);
    // only deny/ask rules are applied so operators stay in control.
    const droppedAllowCount = settingsRules.filter((r) => r.effect === "allow").length;
    if (droppedAllowCount > 0) {
      console.warn(
        `[koi/${hostId}] ${droppedAllowCount} settings allow rule(s) are not enforced when a ` +
          `custom permission backend is active (koi start). ` +
          `Only deny and ask rules take effect on this path. ` +
          `Use \`koi tui\` or remove allow rules from settings.`,
      );
    }
    const restrictingRules = sortRules(settingsRules.filter((r) => r.effect !== "allow"));
    if (restrictingRules.length > 0) {
      // Compile rules once at construction — never recompile per-query.
      const compiledRules: readonly CompiledRule[] = restrictingRules.map((r) => ({
        ...r,
        compiled: compileGlob(r.pattern),
      }));
      const wrappedCheck = async (query: PermissionQuery): Promise<PermissionDecision> => {
        const decision = evaluateRules(query, compiledRules);
        // Sentinel "No matching permission rule" means settings have no deny/ask opinion.
        // Delegate to the inner marker-aware backend (e.g. createPatternPermissionBackend).
        if (decision.effect === "ask" && decision.reason === "No matching permission rule") {
          return inner.check(query);
        }
        return decision;
      };
      // Preserve the marker-aware capability flag so koi start retains dual-key evaluation.
      permBackend = {
        check: wrappedCheck,
        ...(inner.dispose != null ? { dispose: inner.dispose } : {}),
        ...(inner.supportsDefaultDenyMarker === true
          ? { supportsDefaultDenyMarker: true as const }
          : {}),
      };
    } else {
      permBackend = inner;
    }
  } else {
    // TUI single-key mode: widen command-scoped rules (fail-closed).
    const { rules: widenedRules, hadCommandScoped } = widenCommandScopedRulesForTui(settingsRules);
    if (hadCommandScoped) {
      console.warn(
        `[koi/${hostId}] command-scoped settings rules are widened to tool-level in TUI mode ` +
          `(deny/ask become tool-wide; allow rules are stripped). ` +
          `Use \`koi start\` for precise command-scoped enforcement.`,
      );
    }
    // Rule ordering: policy settings → non-policy restrict → built-in allows →
    // fs_read workspace guard → non-policy allows.
    //
    // Non-policy deny/ask rules come before built-in TUI allows so that
    // user/project/local/flag deny rules fire first. Non-policy allow rules come
    // AFTER the out-of-workspace fs_read guard so that a broad "allow all" rule
    // in project settings cannot bypass the workspace boundary prompt.
    // Policy is tightening-only on TUI path as well: allows are already stripped at
    // collection time, but guard here explicitly to prevent any future regression.
    const policySettingsRules = sortRules(
      widenedRules.filter((r) => r.source === "policy" && r.effect !== "allow"),
    );
    const subPolicyRestrictRules = sortRules(
      widenedRules.filter((r) => r.source !== "policy" && r.effect !== "allow"),
    );
    const subPolicyAllowRules = sortRules(
      widenedRules.filter((r) => r.source !== "policy" && r.effect === "allow"),
    );
    permBackend = createPermissionBackend({
      mode: settingsDefaultMode,
      rules: [
        ...policySettingsRules,
        ...subPolicyRestrictRules,
        ...TUI_ALLOW_RULES,
        ...(config.planningEnabled === true
          ? [TUI_WRITE_PLAN_ALLOW_RULE, ...TUI_PLAN_PERSIST_ALLOW_RULES]
          : []),
        {
          pattern: "fs_read",
          action: "invoke",
          effect: "allow",
          source: "policy",
          context: { path: `${cwd}/**` },
        },
        {
          pattern: "fs_read",
          action: "invoke",
          effect: "ask",
          source: "policy",
          reason: "File is outside the workspace — approve to read",
        },
        ...subPolicyAllowRules,
      ],
    });
  }
  const FS_PATH_TOOLS: ReadonlySet<string> = new Set(["fs_read", "fs_write", "fs_edit"]);

  // Bash prefix enrichment (#1881). Feeds the raw command to
  // @koi/middleware-permissions so it can derive a stable
  // `<toolId>:<prefix>` resource for policy evaluation. Enables the
  // `!complex` structural ratchet and dangerous-command ratchet on
  // the decision path regardless of the backend's prefix-rule
  // support — those fire on any allow decision that resolves a
  // compound or known-unsafe command.
  //
  // Tool id matches case-insensitively: the builtin bash tool
  // registers as "Bash" (capital) while some adapters still use
  // "bash". Resolver only kicks in when `input.command` is a string,
  // so non-bash tools and malformed inputs fall through to the
  // plain tool id.
  //
  // createPermissionBackend now sets supportsDefaultDenyMarker: true and stamps
  // fall-through ask decisions with IS_DEFAULT_ASK, enabling full dual-key semantic
  // enforcement. allowLegacyBackendBashFallback is no longer needed here.
  const permMw = createPermissionsMiddleware({
    backend: permBackend,
    description: config.permissionsDescription ?? "koi tui — default permission mode",
    ...(config.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: config.approvalTimeoutMs }
      : {}),
    resolveBashCommand: (toolId, input) =>
      toolId.toLowerCase() === "bash" && typeof input.command === "string"
        ? input.command
        : undefined,
    enableBashSpecGuard: true,
    resolveToolPath: (
      toolId: string,
      input: import("@koi/core").JsonObject,
    ): string | undefined => {
      if (!FS_PATH_TOOLS.has(toolId)) return undefined;
      const raw = input.path;
      if (typeof raw !== "string") return undefined;
      return resolveFsPath(raw, cwd);
    },
    ...(config.persistentApprovals !== undefined
      ? { persistentApprovals: config.persistentApprovals, persistentAgentId: hostId }
      : {}),
  });

  // --- Execution stack exports (bash handle + background task state) ---
  // The execution preset stack owns OS sandbox, bash-with-hooks, the
  // mutable bgController, the live subprocess counter, the task board
  // proxy, and the bash_background / task_* tool providers. We just
  // read the exports here for the fields that feed into buildCoreProviders
  // (bashHandle.tool) and the returned KoiRuntimeHandle (sandboxActive,
  // hasActiveBackgroundTasks, shutdownBackgroundTasks).
  const bashHandle = earlyContribution.exports.bashHandle as
    | import("@koi/tools-bash").BashToolHandle
    | undefined;
  const sandboxActive = (earlyContribution.exports.sandboxActive as boolean | undefined) ?? false;
  const _tuiAgentId = precomputedAgentId;

  // --- Core providers (search + fs + web + bash) via shared-wiring ---
  // The shared `buildCoreProviders` helper wires the exact same base set
  // that `koi start` gets, so adding a new "both hosts" tool = one edit.
  // TUI contributes its hooks-enabled Bash variant via the `bashTool` field.
  const coreProviders = buildCoreProviders({
    cwd,
    filesystemBackend,
    ...(bashHandle !== undefined ? { bashTool: bashHandle.tool } : {}),
    ...(config.filesystemOperations !== undefined
      ? { filesystemOperations: config.filesystemOperations }
      : {}),
  });

  // --- @koi/skills-runtime + @koi/skill-tool: on-demand skill discovery and loading ---
  // Three-tier discovery: bundled → user (~/.claude/skills) → project (.claude/skills).
  // Project skills shadow user skills which shadow bundled skills.
  //
  // Known limitation: the Skill tool descriptor bakes the skill listing at creation
  // time. After session reset, resolver.load() sees fresh files but the model still
  // sees the old descriptor listing. Full fix requires hot-swappable tool descriptors
  // in createKoi — tracked as a known limitation. The system prompt skill snapshot
  // --- @koi/middleware-planning + @koi/middleware-plan-persist ---
  // Opt-in via `config.planningEnabled`. When on, both bundles are
  // wired together: plan-persist's `onPlanUpdate` is plugged into
  // planning's commit hook so every successful `koi_plan_write` is
  // mirrored to `<cwd>/.koi/plans/_active/<sha256(sessionId)>.md` and
  // `koi_plan_save` / `koi_plan_load` tools become available to the
  // model. The journal makes plan checkpoints survive process
  // restart; the model can also explicitly checkpoint with a slug for
  // git-diffable / cross-session named plans (#1842).
  //
  // Note: plan-persist hydrates its own mirror but cannot reach
  // planning's in-process `currentPlan` (no public setter), so a
  // restart's prior plan is recoverable via the save/load tools but
  // is NOT auto-injected into the model's prompt. Hosts that want
  // that behavior can call `planPersist.restoreFromJournal(sessionId)`
  // and inject the items into a system reminder.
  const planPersistBundle =
    config.planningEnabled === true ? createPlanPersistMiddleware({ cwd }) : undefined;
  const planBundle =
    config.planningEnabled === true
      ? createPlanMiddleware({
          ...(planPersistBundle !== undefined
            ? { onPlanUpdate: planPersistBundle.onPlanUpdate }
            : {}),
        })
      : undefined;

  // --- Engine adapter: drives model→tool→model loop via runTurn ---
  //
  // `maxTurns` is plumbed from resolved governance state so the transcript
  // adapter's `runTurn` loop shares the same ceiling as the engine guard
  // (`limits.maxTurns` below) and the governance controller's iteration
  // sensor. Without this thread, a caller setting `--max-turns 50` could
  // still be cut off at 25 by the adapter before either other path fires.
  const transcript: InboundMessage[] = [];
  const rawEngineAdapter = createTranscriptAdapter({
    engineId: config.engineId ?? "koi-tui",
    modelAdapter,
    transcript,
    maxTranscriptMessages: MAX_TRANSCRIPT_MESSAGES,
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(config.getGeneration !== undefined ? { getGeneration: config.getGeneration } : {}),
    // KOI_COMPACTION_WINDOW: override context window size for testing compaction
    // without changing real model config. E.g.: KOI_COMPACTION_WINDOW=2000
    budgetConfig:
      config.getCurrentModel !== undefined
        ? (): BudgetConfig => {
            // biome-ignore lint/style/noNonNullAssertion: narrowed above, satisfies exactOptionalPropertyTypes
            const resolved = config.getCurrentModel!();
            const activeModel = typeof resolved === "string" ? resolved : resolved.model;
            const activeWindow = typeof resolved === "string" ? undefined : resolved.contextLength;
            const envOverride =
              process.env.KOI_COMPACTION_WINDOW !== undefined
                ? Number(process.env.KOI_COMPACTION_WINDOW)
                : undefined;
            // Env override (test) wins; picker-provided window covers unknown
            // models; registry default falls through.
            return budgetConfigForModel(activeModel, envOverride ?? activeWindow);
          }
        : budgetConfigForModel(
            modelName,
            process.env.KOI_COMPACTION_WINDOW !== undefined
              ? Number(process.env.KOI_COMPACTION_WINDOW)
              : undefined,
          ),
  });
  // TEMP #1638: dev-only env-var hook to engage applyActivityTimeout in the
  // current `createTranscriptAdapter → createKoi` path so the wrapper can be
  // exercised manually via TUI / headless before the #1459 createRuntime
  // migration lands. Remove this block once the runtime path is the primary
  // adapter factory for the CLI.
  const idleWarn = Number(process.env.KOI_IDLE_WARN_MS);
  const idleTerm = Number(process.env.KOI_IDLE_TERMINATE_MS);
  const wall = Number(process.env.KOI_WALL_CLOCK_MS);
  const timeoutEnabled = Number.isFinite(idleWarn) || Number.isFinite(wall);
  const timeoutWrapped = timeoutEnabled
    ? (await import("@koi/runtime")).applyActivityTimeout(rawEngineAdapter, {
        ...(Number.isFinite(idleWarn) ? { idleWarnMs: idleWarn } : {}),
        ...(Number.isFinite(idleTerm) ? { idleTerminateMs: idleTerm } : {}),
        ...(Number.isFinite(wall) ? { maxDurationMs: wall } : {}),
      })
    : rawEngineAdapter;
  // applyActivityTimeout's synthetic `done.metadata.terminatedBy` is
  // outside createTranscriptAdapter's `explainNonCompletedStop` fallback
  // scope (the fallback lives INSIDE the transcript adapter and never
  // runs once the wrapper aborts the inner stream). Mirror the fallback
  // here: when a timeout-authored `done` is about to be yielded, inject
  // a visible `text_delta` so the TUI transcript surfaces the reason.
  const engineAdapter: EngineAdapter = timeoutEnabled
    ? {
        ...timeoutWrapped,
        stream(input: EngineInput): AsyncIterable<EngineEvent> {
          return (async function* (): AsyncIterable<EngineEvent> {
            for await (const ev of timeoutWrapped.stream(input)) {
              if (ev.kind === "done" && ev.output.metadata?.terminatedBy === "activity-timeout") {
                const reason = ev.output.metadata.terminationReason;
                const elapsed =
                  typeof ev.output.metadata.elapsedMs === "number"
                    ? ev.output.metadata.elapsedMs
                    : 0;
                const label =
                  reason === "idle"
                    ? "inactivity"
                    : reason === "wall_clock"
                      ? "wall-clock"
                      : String(reason ?? "unknown");
                const secs = Math.round(elapsed / 1000);
                yield {
                  kind: "text_delta",
                  delta: `\n[Turn interrupted by activity timeout (${label}) after ${secs}s.]\n`,
                };
              }
              yield ev;
            }
          })();
        },
      }
    : rawEngineAdapter;

  // --- @koi/middleware-exfiltration-guard: block secret exfiltration ---
  // Intercepts tool inputs and network requests, redacting/blocking patterns
  // that match known secret formats (API keys, tokens, credentials).
  // Must be in the middleware stack to protect shell and web_fetch from leaking
  // workspace secrets — omitting it is a security regression.
  const exfiltrationGuardMw = createExfiltrationGuardMiddleware();

  // --- Core middleware slots (shared with `koi start`) ---
  // `buildCoreMiddleware` is the single source of truth for the
  // permissions / hook / system-prompt / session-transcript factory
  // calls. Each host splices the slots into its own middleware order
  // below. System prompt must be built before spawnToolProvider so
  // children can inherit it; session transcript is NOT inherited
  // (per-runtime mutable state).
  const coreSlots = buildCoreMiddleware({
    permissionsMiddleware: permMw,
    hooks: allHooks,
    // Merge stack-contributed hookExtras (e.g. observability's
    // onExecuted tap for trajectory recording) with host-specific
    // extras (promptCallFn for prompt hooks).
    hookExtras: {
      ...earlyContribution.hookExtras,
      ...(hasPromptHooks ? { promptCallFn } : {}),
    },
    forceHookSlot: true,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.session !== undefined ? { session: config.session } : {}),
  });
  // Local aliases kept so the downstream trace-wrap array literal and
  // spawn `inheritedMiddleware` array read the same as before.
  // `forceHookSlot: true` above makes `coreSlots.hook` guaranteed
  // non-undefined; the runtime check preserves that invariant without
  // a non-null assertion (banned by CLAUDE.md).
  if (coreSlots.hook === undefined) {
    throw new Error("tui-runtime: coreSlots.hook is undefined despite forceHookSlot:true");
  }
  const hookMw = coreSlots.hook;
  const systemPromptMw = coreSlots.systemPrompt;
  const sessionTranscriptMw = coreSlots.sessionTranscript;

  // --- Zone B: resolve manifest-declared middleware ---
  // Resolved BEFORE late-phase stack activation and BEFORE the
  // child-inheritance snapshot below, so that:
  //   (1) spawned child agents inherit the same manifest-declared
  //       middleware as the parent — preventing a split-brain where
  //       delegated work silently escapes manifest policy.
  //   (2) resolved entries can read early-phase stack exports
  //       (bashHandle, trajectoryStore, ...) via
  //       `ManifestMiddlewareContext.stackExports`.
  //
  // Unknown names throw with the full registered-name list. Core
  // middleware names are rejected by the manifest loader earlier
  // and cannot reach this code path. The composed chain wraps
  // zone B from outside with `hook`/`permissions`/`exfiltration-
  // guard` so repo-authored content only sees already-gated,
  // already-redacted traffic (see `compose-middleware.ts`).
  //
  // (The manifest+spawn incompatibility check runs earlier —
  // BEFORE activateStacks — so a rejected config cannot mutate
  // disk through checkpoint/MCP/etc. stack activation before the
  // error surfaces.)
  const manifestMiddlewareRegistry =
    config.middlewareRegistry ??
    createBuiltinManifestRegistry({
      allowFileBackedSinks: config.allowManifestFileSinks === true,
    });
  // workingDirectory is threaded from `config.cwd` (same source as
  // file tools and permission scope) rather than `process.cwd()`, so
  // embedders that build runtimes for workspaces other than the
  // launcher process directory get consistent path resolution across
  // audit sinks, fs_read permissions, and Bash tool working dir.
  const zoneBWorkingDirectory = config.cwd ?? process.cwd();
  // Cleanup callbacks registered by file-backed manifest middleware
  // factories (currently only @koi/middleware-audit, which opens an
  // NDJSON writer at resolution time). Fired from runtime.dispose()
  // on the returned handle in the success path, and from the
  // assembly-failure unwind below when any step between resolution
  // and the return throws.
  const manifestMiddlewareShutdownHooks: Array<() => Promise<void> | void> = [];
  // Unwind helper: fires registered cleanup callbacks in reverse
  // order, swallowing individual errors. Used by the post-resolution
  // assembly-failure path (see the top-level try/catch below).
  const unwindManifestMiddlewareHooks = async (): Promise<void> => {
    for (const hook of [...manifestMiddlewareShutdownHooks].reverse()) {
      try {
        await hook();
      } catch (cleanupErr) {
        console.warn(
          `[koi/${hostId}] manifest-middleware cleanup failed during error unwind: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
  };
  // Track whether ownership of manifest resources has been
  // transferred to the returned runtime handle. Set to `true`
  // immediately before `return` below. If any error escapes the
  // assembly between here and the return, the outer catch at the
  // end of the function invokes `unwindManifestMiddlewareHooks` to
  // release file descriptors / flush timers before rethrowing.
  // `let` is justified because the flag is mutated at the success
  // exit point.
  let handleOwnershipTransferred = false;
  // Runtime-wide shared sink cache for file-backed manifest
  // middleware. Parent resolve + every per-child re-resolution
  // share this map so a single NDJSON writer serves one canonical
  // filePath regardless of how many spawns run. See the block
  // comment on `ManifestMiddlewareContext.sharedAuditSinks` for
  // why independent writers per child would corrupt the trail.
  const sharedAuditSinks: ManifestMiddlewareContext["sharedAuditSinks"] = new Map();
  // Parent-scoped accumulator for failures that happen during
  // per-child manifest cleanup (audit sink close, release hook
  // throws, etc). drainHooks() in the per-child factory appends
  // here instead of only logging, and wrappedDispose surfaces
  // any accumulated entries as part of its AggregateError on the
  // next parent-visible dispose — guaranteeing host observability
  // even when children outlive the parent's first dispose call.
  const childManifestCleanupFailures: unknown[] = [];
  let zoneBMiddleware: readonly KoiMiddleware[];
  try {
    zoneBMiddleware = await resolveManifestMiddleware(
      config.manifestMiddleware,
      manifestMiddlewareRegistry,
      {
        sessionId: config.session?.sessionId ?? "no-session",
        hostId,
        workingDirectory: zoneBWorkingDirectory,
        stackExports: earlyContribution.exports,
        registerShutdown: (fn) => {
          manifestMiddlewareShutdownHooks.push(fn);
        },
        sharedAuditSinks,
      },
    );
  } catch (err) {
    // Resolution itself threw (unknown-name, blocklist, audit path
    // validation, etc.). Unwind any partially-constructed resources
    // from factories that registered before the failure, then
    // rethrow.
    await unwindManifestMiddlewareHooks();
    throw err;
  }

  // Post-resolution assembly is wrapped so any subsequent failure
  // (late-phase stack activation, middleware composition, tracing
  // setup, createKoi, session rotation wiring, etc.) unwinds the
  // manifest resources that were opened at resolution time. Without
  // this, an error after resolve would leak the NDJSON writer +
  // flush timer of an open audit sink for the life of the process.
  try {
    // --- Late-phase stack activation (spawn + any future late stacks) ---
    // Now that the core middleware and zone B are both built, publish
    // the child-inheritance list into the late context's `host` bag
    // and fire the late pass. Spawn reads
    // `LATE_PHASE_HOST_KEYS.inheritedMiddleware` and composes its
    // child adapter around it.
    //
    // Zone B is INTENTIONALLY NOT inherited — see
    // `buildInheritedMiddlewareForChildren` for the rationale. Sharing
    // parent middleware instances with children would interleave
    // mutable per-session state (e.g. audit queues + hash chains).
    //
    // (The spawn+zoneB incompatibility check runs earlier, BEFORE
    // manifest middleware is resolved, so that a rejected config
    // cannot cause any factory to open files or allocate resources.)
    const inheritedMiddlewareForChildren = buildInheritedMiddlewareForChildren({
      permissions: permMw,
      exfiltrationGuard: exfiltrationGuardMw,
      hook: hookMw,
      ...(systemPromptMw !== undefined ? { systemPrompt: systemPromptMw } : {}),
      // Planning MUST be inherited: the inherited-component-provider
      // copies `write_plan` into the child tool set, so the child
      // needs the middleware to intercept the tool call. Otherwise
      // the call falls through to the provider's throwing fallback.
      // The middleware is session-keyed, so sharing with children is
      // safe — parent and child have distinct sessionIds. The same
      // logic applies to plan-persist: when planning is on, children
      // inherit koi_plan_save/koi_plan_load and need the middleware
      // to intercept those calls with the parent's backend.
      ...(planBundle !== undefined ? { plan: planBundle.middleware } : {}),
      ...(planPersistBundle !== undefined ? { planPersist: planPersistBundle.middleware } : {}),
    });
    // Build the per-child manifest-middleware factory. Each call
    // re-runs `resolveManifestMiddleware` with a fresh context so
    // the child gets its own middleware instances (own audit
    // queue, own lifecycle hooks) rather than sharing the parent's
    // mutable state. The child context's sessionId includes a
    // unique per-spawn `childRunId` so sibling children never
    // collapse onto one derived identifier.
    //
    // The shared-sink cache (created above, captured in closure)
    // is passed to every per-child resolve too. File-backed
    // middleware (audit) checks the cache and reuses the parent's
    // already-open writer instead of opening a new one per child.
    // One writer per canonical file → no interleaved independent
    // writers → no corrupted hash chains. Each child still gets
    // its own middleware instance (own queue, own lifecycle
    // hooks) routed through the shared sink.
    //
    // Cleanup callbacks: only the FIRST resolver to open a sink
    // registers the close hook. Per-child resolutions that reuse
    // the cached sink do NOT re-register close, so the dispose
    // chain closes each sink exactly once.
    const buildPerChildManifestMiddlewareFactory = ():
      | ((childCtx: {
          readonly childRunId: string;
          readonly parentAgentId: string;
          readonly childAgentId: string;
          readonly childAgentName: string;
        }) => Promise<{
          readonly middleware: readonly KoiMiddleware[];
          readonly unwind?: () => Promise<void> | void;
        }>)
      | undefined => {
      if ((config.manifestMiddleware ?? []).length === 0) {
        return undefined;
      }
      return async (childCtx) => {
        // Read the LIVE parent runtime session id, not a static
        // manifest label. `runtimeForRotation` is the mutable
        // reference the factory populates once the engine runtime
        // is constructed; it rotates on cycleSession() and rebinds
        // on resume. Reading it here means children spawned after
        // a /clear or /rewind correctly inherit the rotated parent
        // session id as their prefix. Fall back to a neutral label
        // on the (normally unreachable) pre-assignment path.
        const liveParentSessionId = runtimeForRotation?.sessionId ?? "parent-session";
        // Per-child registerShutdown collects hooks into a local
        // array that is invoked via a synthetic cleanup middleware
        // on the child's `onSessionEnd`. This gives third-party
        // factories a real per-child cleanup channel without ever
        // touching the parent runtime's shutdown array — so cleanup
        // fires exactly at child-session boundary and never
        // accumulates one-per-spawn on long-lived parents.
        //
        // Built-ins (@koi/middleware-audit) hit the sharedAuditSinks
        // cache and skip registerShutdown entirely on the per-child
        // path, so this channel stays empty for them and no synthetic
        // middleware is appended.
        const perChildShutdownHooks: Array<() => Promise<void> | void> = [];
        // Per-hook completion tracking mirrors the parent dispose
        // path: a transient failure on one hook (e.g. flaky audit
        // flush) must stay retryable on the next drainHooks call,
        // while already-successful hooks stay latched and do not
        // re-run. A single `drained` flag would either drop the
        // failed hook forever or re-run already-successful hooks
        // and risk double-close.
        const completedChildHooks = new WeakSet<() => Promise<void> | void>();
        const drainHooks = async (): Promise<void> => {
          // Reverse order so later registrations unwind first,
          // matching the parent's registerShutdown semantics.
          // Collect every hook failure: push onto the parent-
          // scoped accumulator so wrappedDispose can surface it
          // on the next parent-visible lifecycle operation, AND
          // throw an AggregateError so the immediate caller
          // (onSessionEnd / unwind) sees the failure too.
          const errors: unknown[] = [];
          for (const hook of [...perChildShutdownHooks].reverse()) {
            if (completedChildHooks.has(hook)) continue;
            try {
              await hook();
              completedChildHooks.add(hook);
            } catch (err) {
              errors.push(err);
              childManifestCleanupFailures.push(err);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              `per-child manifest cleanup had ${errors.length} failure(s) at child session end. ` +
                "Audit sinks or other file-backed child cleanup may not have fully flushed — " +
                "the failures have also been attached to the parent runtime's dispose chain so the " +
                "host's shutdown-reporting path will observe them. A subsequent drain (e.g. retry " +
                "from wrappedDispose) will retry only the hooks that failed.",
            );
          }
        };
        let childMiddleware: readonly KoiMiddleware[];
        try {
          childMiddleware = await resolveManifestMiddleware(
            config.manifestMiddleware,
            manifestMiddlewareRegistry,
            {
              // Label the child session by the CHILD agent id +
              // runId, not the parent agent id. Operators
              // correlating a child audit stream back to the
              // spawned agent need the child identity in the
              // prefix; parentAgentId is retained in
              // `parent:` so the lineage is still recoverable.
              sessionId: `${liveParentSessionId}/parent:${childCtx.parentAgentId}/child:${childCtx.childAgentName}:${childCtx.childAgentId}:${childCtx.childRunId}`,
              hostId,
              workingDirectory: zoneBWorkingDirectory,
              // Child re-resolution inherits the parent's stack
              // exports. This keeps the parent and spawned
              // children on the same manifest-middleware policy:
              // any factory that legitimately reads a parent-
              // exported handle (bashHandle, trajectory store,
              // checkpoint, ...) keeps working on the child
              // path instead of silently degrading when
              // delegated. The Readonly<Record<string, unknown>>
              // shape advertised by ManifestMiddlewareContext
              // remains the contract: factories must treat
              // inherited handles as read-only and never mutate
              // parent-scoped state. A child runtime that needs
              // its own early-phase exports must run through a
              // full independent runtime-factory assembly — out
              // of scope for per-child manifest re-resolution.
              stackExports: earlyContribution.exports,
              registerShutdown: (fn) => {
                perChildShutdownHooks.push(fn);
              },
              sharedAuditSinks,
            },
          );
        } catch (resolveErr) {
          // Factory partially allocated resources before throwing.
          // Drain whatever has been registered so nothing leaks,
          // then re-throw so the engine converts it to a
          // SpawnResult.error.
          await drainHooks();
          throw resolveErr;
        }
        if (perChildShutdownHooks.length === 0) {
          return { middleware: childMiddleware };
        }
        // Append a synthetic cleanup middleware that drains the
        // collected hooks at child session end. Observe-phase +
        // low priority so it runs after every real middleware's
        // own onSessionEnd. drainHooks() is idempotent: whichever
        // path fires first (normal completion via onSessionEnd
        // OR post-resolution failure via `unwind`) wins, and the
        // other becomes a no-op.
        const cleanupMiddleware: KoiMiddleware = {
          name: "per-child-cleanup",
          phase: "observe",
          priority: 999,
          concurrent: true,
          describeCapabilities: () => undefined,
          onSessionEnd: async () => {
            await drainHooks();
          },
        };
        return {
          middleware: [...childMiddleware, cleanupMiddleware],
          unwind: drainHooks,
        };
      };
    };
    const perChildManifestMiddlewareFactory = buildPerChildManifestMiddlewareFactory();
    const lateContext: import("./preset-stacks.js").StackActivationContext = {
      ...earlyContext,
      host: {
        ...earlyContextHost,
        [LATE_PHASE_HOST_KEYS.inheritedMiddleware]: inheritedMiddlewareForChildren,
        ...(perChildManifestMiddlewareFactory !== undefined
          ? {
              [LATE_PHASE_HOST_KEYS.perChildManifestMiddlewareFactory]:
                perChildManifestMiddlewareFactory,
            }
          : {}),
        ...(earlyContribution.exports.getTaskBoard !== undefined
          ? { [LATE_PHASE_HOST_KEYS.getTaskBoard]: earlyContribution.exports.getTaskBoard }
          : {}),
        ...(earlyContribution.exports.getStore !== undefined
          ? { [LATE_PHASE_HOST_KEYS.getStore]: earlyContribution.exports.getStore }
          : {}),
      },
    };
    const lateContribution = await activateStacks(lateContext, {
      phase: "late",
      ...(enabledStackIds !== undefined ? { enabled: enabledStackIds } : {}),
    });
    const stackContribution = mergeStackContributions(earlyContribution, lateContribution);

    // --- Checkpoint handle exported by the checkpoint preset stack ---
    // Read here for the returned KoiRuntimeHandle.checkpoint field.
    const checkpointHandle = stackContribution.exports.checkpointHandle as
      | import("@koi/checkpoint").Checkpoint
      | undefined;

    // --- MCP resolvers exported by the MCP preset stack ---
    // Read here for the returned KoiRuntimeHandle.getMcpStatus().
    const mcpResolver = stackContribution.exports.mcpResolver as
      | import("@koi/mcp").McpResolver
      | undefined;
    const mcpPluginResolver = stackContribution.exports.mcpPluginResolver as
      | import("@koi/mcp").McpResolver
      | undefined;
    const mcpTransportByName = stackContribution.exports.mcpTransportByName as
      | ReadonlyMap<string, "http" | "stdio" | "sse">
      | undefined;
    const mcpPluginTransportByName = stackContribution.exports.mcpPluginTransportByName as
      | ReadonlyMap<string, "http" | "stdio" | "sse">
      | undefined;
    const mcpOAuthCapableNames = stackContribution.exports.mcpOAuthCapableNames as
      | ReadonlySet<string>
      | undefined;

    // Hoisted above the audit/governance blocks: compliance recorders
    // and the onViolation callback need a LIVE session id (rotates on
    // cycleSession / rebindSessionId) rather than the static
    // construction-time `config.session.sessionId`. Assigned at line
    // ~2601 after createKoi returns; the getters below only dereference
    // it when recordCompliance / onViolation fire, which happens after
    // the runtime is built.
    // let: justified — single mutable ref shared across closures.
    let runtimeForRotation: import("@koi/engine").KoiRuntime | undefined;
    const getLiveSessionId = (): string =>
      runtimeForRotation?.sessionId ?? config.session?.sessionId ?? "no-session";

    // --- Audit middleware (opt-in via config.auditNdjsonPath) ---
    // Build the NDJSON sink + hash-chained audit middleware when the host
    // host opted in (KOI_AUDIT_NDJSON env var in the TUI). The runtime
    // owns both the middleware and the underlying sink's writer/timer;
    // `shutdownBackgroundTasks` below flushes and closes on shutdown.
    // let: retained so shutdown can flush+close.
    let auditMwForShutdown:
      | { readonly flush: () => Promise<void>; readonly close: () => Promise<void> }
      | undefined;
    const auditPresetExtras: KoiMiddleware[] = [];
    // Compliance recorders accumulated from each active audit sink.
    // Used later to populate governanceBackend.compliance.
    const complianceRecorders: ComplianceRecorder[] = [];
    // Audit sink passed into createDecisionLedger so /trajectory shows
    // audit:ok and surfaces compliance_event / permission_decision rows
    // in the audit lane. Only the SQLite sink is captured: NDJSON's
    // `.query(sessionId)` re-parses the entire file on every call, and
    // the TUI refreshes the ledger after every settled turn — NDJSON
    // would degrade to O(n²) cumulative work over a long session.
    // NDJSON-only setups therefore see `audit:n/a` by design; enable
    // SQLite for live ledger access.
    let ledgerAuditSink: AuditSink | undefined;
    if (config.auditNdjsonPath !== undefined) {
      // Collision guard: refuse to start if the legacy host-level
      // audit path (env-driven KOI_AUDIT_NDJSON / config.auditNdjsonPath)
      // points at the same canonical file as any enabled
      // `@koi/middleware-audit` manifest entry. Two independent
      // writers against the same NDJSON file would interleave
      // records, corrupt the hash/signing chain, and break the
      // integrity story that the manifest audit path is trying
      // to harden. Hosts that want both paths active must target
      // different files.
      const legacyCanonical = canonicalizeAuditSinkPath(
        config.auditNdjsonPath,
        zoneBWorkingDirectory,
      );
      if (legacyCanonical !== undefined && config.manifestMiddleware !== undefined) {
        for (const entry of config.manifestMiddleware) {
          if (entry.enabled === false || entry.name !== "@koi/middleware-audit") continue;
          const entryPath = entry.options?.filePath;
          if (typeof entryPath !== "string" || entryPath.length === 0) continue;
          const entryCanonical = canonicalizeAuditSinkPath(entryPath, zoneBWorkingDirectory);
          if (entryCanonical === legacyCanonical) {
            throw new Error(
              `audit sink collision: host-level auditNdjsonPath "${config.auditNdjsonPath}" ` +
                `resolves to the same canonical path as manifest @koi/middleware-audit entry "${entryPath}". ` +
                "Two independent writers cannot share the same NDJSON file — they would interleave " +
                "records and corrupt the hash/signing chain. Point one path at a different file, or " +
                "disable one of the audit surfaces.",
            );
          }
        }
      }
      // manifest.audit.ndjson is rejected at tui-command.ts before this point —
      // ancestor-symlink swaps between revalidation and open cannot be blocked
      // without openat-style APIs unavailable in Node.js/Bun. All manifest-derived
      // audit paths require env var overrides; manifestNdjsonSourcePath is therefore
      // always undefined here. The guard below is defensive only.
      if (config.manifestNdjsonSourcePath !== undefined) {
        throw new Error(
          "manifest.audit.ndjson: manifest-derived paths are not supported. " +
            "Set KOI_AUDIT_NDJSON instead.",
        );
      }
      const auditSink = createNdjsonAuditSink({ filePath: config.auditNdjsonPath });
      const auditMw = createAuditMiddleware({ sink: auditSink, signing: true });
      complianceRecorders.push(
        createAuditSinkComplianceRecorder(auditSink, {
          sessionId: getLiveSessionId,
        }),
      );
      auditPresetExtras.push(auditMw);
      // Deliberately NOT captured into `ledgerAuditSink`. The ledger is
      // refreshed after every settled turn; NDJSON `.query(sessionId)`
      // re-parses the entire file on each call, so long sessions would
      // degrade to O(n²) cumulative work. NDJSON-only setups accept
      // `audit:n/a` in /trajectory — point KOI_AUDIT_SQLITE at a DB (or
      // enable both) to get the live audit lane. NDJSON remains the
      // right sink for offline compliance export and forensic replay.
      auditMwForShutdown = {
        flush: () => auditMw.flush(),
        close: () => auditSink.close(),
      };
    }

    // --- SQLite audit middleware (opt-in via config.auditSqlitePath) ---
    // Parallel to NDJSON above. Both can be active simultaneously (tee
    // pattern) as long as they target different files.
    let auditSqliteMwForShutdown:
      | { readonly flush: () => Promise<void>; readonly close: () => Promise<void> }
      | undefined;
    if (config.auditSqlitePath !== undefined) {
      // Collision guard: refuse to start if the SQLite path resolves to the
      // same canonical file as the NDJSON host-level path or any manifest
      // @koi/middleware-audit entry. Two independent writers (especially
      // different formats) against the same file corrupt the audit trail.
      const sqliteCanonical = canonicalizeAuditSinkPath(
        config.auditSqlitePath,
        zoneBWorkingDirectory,
      );
      if (sqliteCanonical !== undefined) {
        // Check against host-level NDJSON path.
        if (config.auditNdjsonPath !== undefined) {
          const ndjsonCanonical = canonicalizeAuditSinkPath(
            config.auditNdjsonPath,
            zoneBWorkingDirectory,
          );
          if (ndjsonCanonical === sqliteCanonical) {
            throw new Error(
              `audit sink collision: auditSqlitePath "${config.auditSqlitePath}" resolves to ` +
                `the same canonical path as auditNdjsonPath "${config.auditNdjsonPath}". ` +
                "SQLite and NDJSON sinks use incompatible formats — they cannot share a file.",
            );
          }
        }
        // Check against manifest @koi/middleware-audit entries.
        if (config.manifestMiddleware !== undefined) {
          for (const entry of config.manifestMiddleware) {
            if (entry.enabled === false || entry.name !== "@koi/middleware-audit") continue;
            const entryPath = entry.options?.filePath;
            if (typeof entryPath !== "string" || entryPath.length === 0) continue;
            const entryCanonical = canonicalizeAuditSinkPath(entryPath, zoneBWorkingDirectory);
            if (entryCanonical === sqliteCanonical) {
              throw new Error(
                `audit sink collision: auditSqlitePath "${config.auditSqlitePath}" resolves to ` +
                  `the same canonical path as manifest @koi/middleware-audit entry "${entryPath}". ` +
                  "Two independent writers cannot share the same file.",
              );
            }
          }
        }
      }
      // manifest.audit.sqlite is rejected at tui-command.ts before this point
      // (manifest-derived SQLite paths are not supported — SQLite must open by
      // pathname for WAL/SHM sidecars, making atomic containment impossible).
      // manifestSqliteSourcePath is therefore always undefined here; the check
      // below is a defensive belt-and-suspenders guard only.
      if (config.manifestSqliteSourcePath !== undefined) {
        throw new Error(
          "manifest.audit.sqlite: manifest-derived SQLite paths are not supported. " +
            "Set KOI_AUDIT_SQLITE instead.",
        );
      }
      const sqliteSink = createSqliteAuditSink({ dbPath: config.auditSqlitePath });
      const sqliteAuditMw = createAuditMiddleware({ sink: sqliteSink, signing: true });
      complianceRecorders.push(
        createAuditSinkComplianceRecorder(sqliteSink, {
          sessionId: getLiveSessionId,
        }),
      );
      auditPresetExtras.push(sqliteAuditMw);
      ledgerAuditSink = sqliteSink;
      auditSqliteMwForShutdown = {
        flush: () => sqliteAuditMw.flush(),
        close: async () => sqliteSink.close(),
      };
    }

    // --- Report middleware (opt-in via config.reportEnabled) ---
    // Accumulates model/tool call metrics and emits a RunReport at session
    // end. No shutdown resources — the report is printed via onReport.
    // let: justified — set once by onReport callback during onSessionEnd.
    let pendingReportText: string | undefined;
    if (config.reportEnabled === true) {
      const reportHandle = createReportMiddleware({
        onReport: (_report, formatted) => {
          // #1862: buffer the formatted text instead of printing
          // immediately. onReport fires during runtime.dispose() →
          // onSessionEnd, while the TUI alt screen may still be active.
          // The host prints pendingReportText after appHandle.stop()
          // releases the alt screen so the output is visible.
          pendingReportText = formatted;
        },
      });
      auditPresetExtras.push(reportHandle.middleware);
      // TODO(#1858): expose reportHandle.getReport / getProgress on
      // KoiRuntimeHandle so the TUI can surface progress in a status
      // bar or /report command.
    }

    // --- Feedback-loop middleware (opt-in via config.feedbackLoop) ---
    // Model-response validation + tool-health tracking. No shutdown resources.
    if (config.feedbackLoop !== undefined) {
      auditPresetExtras.push(createFeedbackLoopMiddleware(config.feedbackLoop));
    }

    // --- Pre-build shared GovernanceController so it is shared between:
    //   1. The engine extension (via ECS component lookup inside createKoi)
    //   2. The L2 createGovernanceMiddleware (observer/recorder)
    //   3. The bridge (via runtime.agent.component(GOVERNANCE) post-createKoi)
    // We contribute it via a GLOBAL_FORGED-priority ComponentProvider so it
    // wins over the BUNDLED-priority provider createKoi installs automatically.
    //
    // `--no-governance` short-circuits the whole block: no shared controller,
    // no backend, no middleware, no extra provider. createKoi's bundled
    // governance provider still fires with engine defaults (so iteration
    // caps continue to bound runaway loops), but the host gets none of the
    // observer/bridge surface. Use this for CI runners that have their own
    // audit stack and do not want the default alerting path.
    const governanceEnabled = config.governanceDisabled !== true;
    const resolvedDurationForGov = resolveMaxDurationMs(config.defaultMaxDurationMs);
    const sharedGovernanceConfig: Partial<GovernanceConfig> = {
      iteration: {
        // --max-turns narrows the per-run turn budget. Default stays at
        // DEFAULT_MAX_TURNS so unset behavior is unchanged.
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        maxDurationMs: resolvedDurationForGov,
        maxTokens: 1_000_000,
      },
      // --max-spawn-depth overrides the engine's default spawn.maxDepth.
      // Left unset when undefined so `createDefaultGovernanceConfig` can
      // fill in the engine's built-in default (3).
      ...(config.maxSpawnDepth !== undefined
        ? { spawn: { maxDepth: config.maxSpawnDepth, maxFanOut: DEFAULT_MAX_FAN_OUT } }
        : {}),
      ...(config.maxSpendUsd !== undefined && config.maxSpendUsd > 0
        ? {
            cost: resolveCostConfig(config.maxSpendUsd, [
              modelName,
              ...(config.fallbackModelNames ?? []),
            ]),
          }
        : {}),
    };
    const sharedGovernanceController = governanceEnabled
      ? createGovernanceController(sharedGovernanceConfig)
      : undefined;
    const sharedGovernanceProvider =
      sharedGovernanceController !== undefined
        ? createSharedGovernanceProvider(sharedGovernanceController)
        : undefined;

    // L2 governance middleware — observer mode only. Setpoint accounting
    // (turn / token_usage / tool outcomes) is owned by the engine extension
    // `createGovernanceExtension()` from `@koi/engine-reconcile`, which
    // `createKoi` always installs against this same controller. Letting both
    // layers record would double-count every variable and trip caps at half
    // the configured limit. `observerOnly: true` silences the middleware's
    // four `controller.record(...)` sites while keeping:
    //   - policy gate (`backend.evaluator.evaluate()`),
    //   - snapshot-based onAlert dispatch,
    //   - trajectory span (middleware:koi:governance-core in /trajectory),
    //   - describeCapabilities() entry surfaced in /governance.
    //
    // Known limitation (off-by-one on turn_count): the engine extension
    // records `kind: "turn"` in `onBeforeTurn` (record then check), so
    // `maxTurns=N` denies on the Nth pre-gate and yields `N-1` completed
    // turns. The middleware previously recorded post-turn (the correct
    // semantics) but observer mode disables it to avoid the double-count.
    // Tracked separately — fixing requires moving the engine extension's
    // turn record to `onAfterTurn`, outside this PR's surface.
    // --policy-file rules feed the backend's policy gate, which still runs
    // in observer mode (observerOnly silences record() only, not
    // evaluator.evaluate()). Absent --policy-file, fall back to the default-
    // allow backend so /governance renders the synthetic descriptor.
    // --- Violation store ---
    // Auto-wires to ~/.koi/violations.db when governance is enabled (mirrors
    // the governance-alerts.jsonl convention established by gov-9 — zero
    // config required for /governance history backfill to work).
    // Operators can override via --violation-sqlite=<path>.
    // Explicit "" (empty string) disables the default.
    // Violation store is a governance surface — if governance is
    // disabled (`--no-governance`), we never open the DB even when an
    // explicit `--violation-sqlite` path was passed. This prevents a
    // configuration mismatch from hard-failing startup during incident
    // mitigation: the operator disabling governance expects governance
    // side-effects (including durable violation writes) to be off. An
    // explicit path combined with `--no-governance` is ambiguous; we
    // warn so the contradiction is visible and move on without the
    // store.
    let resolvedViolationPath: string | undefined;
    if (!governanceEnabled) {
      if (config.violationSqlitePath !== undefined && config.violationSqlitePath.length > 0) {
        console.warn(
          `[koi-runtime] ignoring --violation-sqlite="${config.violationSqlitePath}" — governance is disabled. ` +
            "Enable governance to persist violations.",
        );
      }
      resolvedViolationPath = undefined;
    } else {
      resolvedViolationPath =
        config.violationSqlitePath !== undefined
          ? config.violationSqlitePath.length > 0
            ? config.violationSqlitePath
            : undefined
          : join(homedir(), ".koi", "violations.db");
    }
    // Degrade gracefully if the default DB path is unreachable. Auto-
    // wiring runs whenever governance is enabled, but `~/.koi` may be
    // unwritable (containers, read-only runners, restricted service
    // users, missing $HOME). A hard failure here would abort runtime
    // startup for a FEATURE — governance history backfill — that is
    // strictly additive. Catch FS/SQLite open failures, continue with
    // `violationStore: undefined`, and log a warning so operators can
    // investigate without losing the rest of the runtime.
    let violationStore: ReturnType<typeof createSqliteViolationStore> | undefined;
    if (resolvedViolationPath !== undefined) {
      try {
        const parent = dirname(resolvedViolationPath);
        const manifestDerived = config.manifestViolationsSourcePath !== undefined;
        if (!existsSync(parent)) {
          // Manifest-derived paths must already have their parent present —
          // auto-creating directories for repo-authored paths expands the
          // write-capability trust boundary. Operator-supplied explicit paths
          // (--violation-sqlite flag) and the implicit default (~/.koi/)
          // retain the previous auto-create behavior.
          if (manifestDerived) {
            throw new Error(
              `manifest.audit.violations: parent directory "${parent}" does not exist. ` +
                "Create it before starting koi tui, or remove the violations: key from manifest.audit.",
            );
          }
          mkdirSync(parent, { recursive: true });
        }
        // manifest.audit.violations is rejected at tui-command.ts before this
        // point (same WAL/SHM atomic-open limitation as manifest.audit.sqlite).
        // manifestDerived is therefore always false here; the guard below is
        // defensive only.
        if (manifestDerived) {
          throw new Error(
            "manifest.audit.violations: manifest-derived SQLite paths are not supported. " +
              "Set KOI_AUDIT_VIOLATIONS instead.",
          );
        }
        violationStore = createSqliteViolationStore({ dbPath: resolvedViolationPath });
        // Register close on manifest shutdown so `runtime.dispose()`
        // drains the buffer and releases the SQLite handle. Without
        // this, non-TUI embeddings that use `runtime.dispose()` as the
        // terminal lifecycle boundary would leak the timer/handle and
        // drop the final buffered entries — `shutdownBackgroundTasks()`
        // below is TUI-specific. close() is idempotent so the parallel
        // call paths are safe.
        //
        // Explicit-path fail-closed signaling: if close() reports a
        // non-zero `droppedCount` AND the operator supplied the path
        // explicitly, we throw so the aggregate shutdown surface marks
        // dispose as failed. Operators who asked for durable violation
        // logging must see the loss as an error, not a warn-line.
        // The implicit default path still swallows with a warning —
        // best-effort, same convention as the graceful-open branch.
        const storeForHook = violationStore;
        const explicitStorePath =
          config.violationSqlitePath !== undefined && config.violationSqlitePath.length > 0;
        manifestMiddlewareShutdownHooks.push(() => {
          try {
            const { droppedCount } = storeForHook.close();
            if (droppedCount > 0 && explicitStorePath) {
              throw new Error(
                `violation store: ${droppedCount} violation(s) were dropped on shutdown for explicitly-configured path "${resolvedViolationPath}". ` +
                  "Durable persistence failed during this run; inspect prior warnings for the underlying SQLite error.",
              );
            }
          } catch (err) {
            if (explicitStorePath) throw err;
            console.warn(
              `[koi/${hostId}] ViolationStore dispose-time close failed (default path, continuing): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Explicit operator configuration is honored fail-closed: when
        // `config.violationSqlitePath` was supplied and non-empty, a
        // failure to open that path is a configuration error, not a
        // best-effort degradation. Operators who asked for durable
        // violation logging get a hard error rather than a silent
        // downgrade that would hide compliance failures.
        //
        // The implicit default (~/.koi/violations.db) still degrades
        // gracefully — missing $HOME, read-only runners, containers —
        // because no one EXPLICITLY asked for persistence there.
        const explicitPath =
          config.violationSqlitePath !== undefined && config.violationSqlitePath.length > 0;
        if (explicitPath) {
          throw new Error(
            `violation store: failed to open explicitly-configured path "${resolvedViolationPath}": ${message}. ` +
              'Fix the path, make it writable, or pass --violation-sqlite="" to disable persistence explicitly.',
            { cause: err },
          );
        }
        console.warn(
          `[koi-runtime] violation store disabled — could not open default "${resolvedViolationPath}": ${message}. ` +
            'Pass --violation-sqlite=<path> to a writable location, or --violation-sqlite="" to silence this.',
        );
        violationStore = undefined;
      }
    }

    const rawGovernanceBackend = governanceEnabled
      ? config.governanceRules !== undefined && config.governanceRules.length > 0
        ? createPatternBackend({ rules: config.governanceRules, defaultDeny: false })
        : createDefaultPatternBackend()
      : undefined;

    const complianceRecorder =
      complianceRecorders.length > 0 ? fanOutComplianceRecorder(complianceRecorders) : undefined;

    const governanceBackend =
      rawGovernanceBackend !== undefined
        ? {
            ...rawGovernanceBackend,
            ...(complianceRecorder !== undefined ? { compliance: complianceRecorder } : {}),
            ...(violationStore !== undefined ? { violations: violationStore } : {}),
          }
        : rawGovernanceBackend;
    const governanceRules: readonly RuleDescriptor[] =
      governanceBackend !== undefined ? await resolveGovernanceRules(governanceBackend) : [];
    const governanceMw =
      governanceEnabled &&
      governanceBackend !== undefined &&
      sharedGovernanceController !== undefined
        ? createGovernanceMiddleware({
            backend: governanceBackend,
            controller: sharedGovernanceController,
            cost: createPricingCostCalculator(),
            observerOnly: true,
            // --alert-threshold overrides the default [0.8, 0.95]. Passed
            // unconditionally when set — governance-middleware validates the
            // list and falls back to its default when undefined.
            ...(config.governanceAlertThresholds !== undefined
              ? { alertThresholds: config.governanceAlertThresholds }
              : {}),
            // Persist every violation to the SQLite store when configured.
            // Additive — does not remove any other subscribers (e.g. bridge).
            // sessionId is resolved from the live runtime at callback time
            // so `cycleSession` / `rebindSessionId` keep persisted rows
            // attributed to the current session — the bridge's
            // `loadRecentViolations({ sessionId })` query can find them
            // against the rotated id, and pre-runtime fires fall back
            // to the startup id (or "no-session" if the host omitted one).
            ...(violationStore !== undefined
              ? {
                  onViolation: (verdict: GovernanceVerdict, request: PolicyRequest) => {
                    if (verdict.ok) return;
                    const sid = getLiveSessionId();
                    for (const v of verdict.violations) {
                      violationStore.record(v, request.agentId, sid, request.timestamp);
                    }
                  },
                }
              : {}),
          })
        : undefined;

    // --- Compose middleware via the standalone `composeRuntimeMiddleware` ---
    // The ordering (outermost → innermost) is defined in one place —
    // compose-middleware.ts. Preset stacks (observability, checkpoint,
    // memory, execution, etc.) plug in via `presetExtras`; user-
    // controlled manifest middleware plugs in via `manifestMiddleware`;
    // the named slots here are the ALWAYS-ON core layers only.
    const allMiddleware = composeRuntimeMiddleware({
      hook: hookMw,
      permissions: permMw,
      exfiltrationGuard: exfiltrationGuardMw,
      ...(config.currentModelMiddleware !== undefined
        ? { currentModel: config.currentModelMiddleware }
        : {}),
      ...(config.modelRouterMiddleware !== undefined
        ? { modelRouter: config.modelRouterMiddleware }
        : {}),
      // Plan is a dedicated zone-C-bottom slot so it runs INSIDE the
      // permissions filter. That's required for its prompt-visibility
      // gate — if permissions removes write_plan from request.tools,
      // planning must see the filtered list, not the pre-filter one.
      ...(planBundle !== undefined ? { plan: planBundle.middleware } : {}),
      ...(planPersistBundle !== undefined ? { planPersist: planPersistBundle.middleware } : {}),
      // presetExtras includes the code-owned stack middleware and
      // main's env-var-gated audit preset extras (from
      // `auditNdjsonPath` / `KOI_AUDIT_NDJSON`). Zone B manifest
      // middleware flows through the separate `manifestMiddleware`
      // slot and is composed strictly INSIDE the security core
      // layers, regardless of array position here.
      presetExtras: [
        ...stackContribution.middleware,
        ...auditPresetExtras,
        ...(governanceMw !== undefined ? [governanceMw] : []),
      ],
      manifestMiddleware: zoneBMiddleware,
      ...(systemPromptMw !== undefined ? { systemPrompt: systemPromptMw } : {}),
      ...(sessionTranscriptMw !== undefined ? { sessionTranscript: sessionTranscriptMw } : {}),
    });

    // --- Required-set invariant: refuse to boot with a gutted chain ---
    // Runs after composition so it checks the actually-assembled list,
    // not the intended inputs. This is the last line of defense
    // against a programmatic caller that constructs a chain without
    // the core security layers. Terminal-capable runtimes (koi tui,
    // koi start) always require hooks + permissions +
    // exfiltration-guard. See `required-middleware.ts`.
    enforceRequiredMiddleware(allMiddleware, {
      terminalCapable: config.terminalCapable ?? true,
    });
    // Wrap every middleware with the trace wrapper when the observability
    // stack is active (provides `trajectoryStore`). When the stack is
    // disabled via `config.stacks` (e.g. a CI runner opting for a
    // minimal assembly), trace wrapping is skipped — the middleware
    // runs without per-span ATIF recording.
    // Monotonic counter avoids Date.now() millisecond collisions on the
    // trace store's idempotent dedup.
    // let: mutable — incremented on each trace step
    let traceCounter = Date.now();
    const tracedMiddleware =
      trajectoryStore !== undefined
        ? allMiddleware.map((mw) =>
            wrapMiddlewareWithTrace(mw, {
              store: trajectoryStore,
              docId: trajectoryDocId,
              clock: () => traceCounter++,
            }),
          )
        : allMiddleware;

    // --- Assemble runtime via createKoi ---
    // When a session is configured, thread `config.session.sessionId` into
    // createKoi as its `sessionId` override so the engine's factory-level
    // session id (used as the JSONL routing key) matches the plain, user-
    // typable UUID the host minted — rather than the default verbose
    // `agent:{agentId}:{uuid}` form. This is what makes the post-quit resume
    // hint short and copy-pasteable.
    //
    // Also pass `rotateSessionId` so `cycleSession()` (fired by
    // `resetSessionState` on `/clear`/`/new`) preserves the host's
    // id format. Without this, the engine would mint a default
    // `agent:{agentId}:{uuid}` on every rotation — the host-owned
    // JSONL file name, post-quit resume hint, and everything else
    // keyed off the stable id would silently diverge from where the
    // session-transcript middleware actually writes subsequent
    // turns (see `session-transcript.ts` — routing reads
    // `ctx.session.sessionId`, which is the engine's rotated id).
    // The rotation callback reads from a mutable ref that tracks
    // the LIVE session id rather than capturing the construction-
    // time `sess.sessionId` value. Hosts may call
    // `runtime.rebindSessionId(...)` between construction and a
    // later `cycleSession()` (e.g. `koi tui` rebinds after a
    // successful `/rewind` so future writes land on the rewound
    // session). With a snapshotted callback, the next `/clear`
    // would snap the engine back to the original startup id —
    // checkpoint reset would prune the wrong chain and the live
    // session's pre-clear snapshots would survive the boundary.
    // The runtime ref is assigned immediately after `createKoi`
    // returns; the engine never invokes `rotateSessionId` during
    // construction, only during a later `cycleSession()`, so the
    // ref is always populated by the time the callback fires.
    // (`runtimeForRotation` is declared above the audit wiring.)
    const runtime = await createKoi({
      manifest: { name: "koi-tui", version: "0.1.0", model: { name: modelName } },
      adapter: engineAdapter,
      middleware: tracedMiddleware,
      ...(():
        | { sessionId: SessionId; rotateSessionId: () => SessionId }
        | Record<string, never> => {
        const sess = config.session;
        if (sess === undefined) return {};
        return {
          sessionId: sess.sessionId,
          rotateSessionId: (): SessionId => {
            // Read from the live runtime so a prior `rebindSessionId`
            // is honored. If somehow the callback fires before the
            // assignment below (it shouldn't — the engine only calls
            // it from `cycleSession()`, which can't run during
            // construction), fall back to the construction id.
            const liveId = runtimeForRotation?.sessionId;
            return (liveId ?? sess.sessionId) as SessionId;
          },
        };
      })(),
      providers: [
        // sharedGovernanceProvider must come first (GLOBAL_FORGED priority = 50)
        // so it wins over createKoi's bundled governance provider (priority = 100).
        // Lower number wins per ECS priority resolution. Omitted when
        // governance is disabled — createKoi's bundled default provider then
        // supplies the controller used by engine-reconcile's extension.
        ...(sharedGovernanceProvider !== undefined ? [sharedGovernanceProvider] : []),
        ...coreProviders,
        ...stackContribution.providers,
        ...(config.extraProviders ?? []),
        ...(planBundle !== undefined ? planBundle.providers : []),
        ...(planPersistBundle !== undefined ? planPersistBundle.providers : []),
      ],
      approvalHandler,
      userId: userInfo().username,
      // Loop detection defaults to ENABLED (createKoi's default).
      // Callers explicitly opt out: `koi tui` passes `false` because its
      // per-submit iteration budget reset + governance caps already
      // bound spirals, and the interactive surface makes false
      // positives expensive. `koi start` omits this field so the
      // default stays on — the auto-allow permission backend means a
      // bad iteration would otherwise hammer tools until the broader
      // caps trip, which is exactly what the detector exists to
      // prevent.
      ...(config.loopDetection !== undefined ? { loopDetection: config.loopDetection } : {}),
      // #1742: each user submit in the TUI is a logically fresh request,
      // so opt in to per-iteration budget reset for turn count and
      // duration. Token usage stays CUMULATIVE across the runtime
      // lifetime so the process retains a hard ceiling on total spend.
      //
      // The cumulative token ceiling is raised from the 100k default to
      // 1M — a 10x relaxation, not 50x — because 100k trips inside a
      // single moderately-long TUI session but 1M still bounds runaway
      // tool/model loops well before they become a real cost incident
      // (~$3-15 worst case on Sonnet 4.6). The per-iteration maxTurns:25
      // reset above is the primary loop guard; this token ceiling is the
      // secondary "user keeps submitting expensive prompts" guard.
      //
      // Cost tracking (`maxCostUsd`) is left at the default-disabled
      // value because costPerInputToken/costPerOutputToken default to 0
      // and we don't have a model-aware pricing source wired in. When
      // a host wires real token pricing, also set `cost.maxCostUsd` here
      // for a stricter dollar-denominated cap.
      resetBudgetPerRun: true,
      // The iteration guard (wired by the default guard extension) and
      // the governance controller are separate enforcement paths. Both
      // must see the same resolved duration or the tighter of the two
      // wins — e.g. the guard's 5-min default would fire before the
      // 30-min governance cap. Thread the resolved values into `limits`
      // (guard). The governance config is now baked into the
      // sharedGovernanceController above (pre-built before createKoi)
      // so it is NOT passed here — the bundled governance provider is
      // overridden by our GLOBAL_FORGED-priority sharedGovernanceProvider.
      //
      // Pin `maxInactivityMs` to the resolved duration in all hosts
      // so the two enforcement paths (wall-clock, inactivity) share
      // one contract. Leaving inactivity at the engine's 5-min
      // default made quiet model-think phases trip TIMEOUT well
      // before the advertised cap. For `koi start` the resolved
      // duration is 5 min anyway (via `defaultMaxDurationMs`), so
      // this match is a no-op; for the interactive TUI it extends
      // inactivity to 30 min, which is the intended posture.
      // `--max-turns N` is plumbed into BOTH the governance controller
      // (setpoint) and the engine's iteration guard (limits) so the two
      // enforcement paths share a single operator-supplied ceiling.
      // Without this, a hardcoded DEFAULT_MAX_TURNS here would win
      // over a higher `--max-turns` value (guard trips first, governance
      // never fires), silently capping runs at 25 turns.
      //
      // `--no-governance` disables the HOST-level governance surface
      // (alerts, bridge, pattern backend, observer MW) but the engine's
      // bundled guard still applies — operators can tune it via
      // `--max-turns`; there is no escape-to-unbounded path by design.
      limits: {
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        maxDurationMs: resolvedDurationForGov,
        maxInactivityMs: resolvedDurationForGov,
        maxTokens: 1_000_000,
      },
    });
    // Hand the live runtime to the rotation closure above. The
    // engine never invokes `rotateSessionId` during construction
    // (only from a later `cycleSession()`), so this assignment
    // happens before any rotation can fire.
    runtimeForRotation = runtime;

    // Wrap runtime.dispose so manifest-middleware cleanup (audit sink
    // close, etc.) runs AFTER the engine's dispose path completes.
    // Engine dispose triggers middleware onSessionEnd hooks, which is
    // when audit writes its final `session_end` record. Closing the
    // sink before dispose would drop that record. We also remove the
    // cleanup from shutdownBackgroundTasks below so it is only wired
    // through this one authoritative path.
    //
    // IMPORTANT: cleanup runs ONLY if `engineDispose()` resolves
    // successfully. The engine's poisoned-runtime contract says that
    // when dispose throws or times out, onSessionEnd/adapter teardown
    // was skipped and in-flight middleware state is still live. The
    // caller is expected to SIGKILL the wedged tool and retry dispose
    // later. Closing manifest resources here would:
    //   1. Prevent the retry dispose from emitting the final
    //      session_end audit record (writer/timer already torn down).
    //   2. Race with any still-running middleware that has not had
    //      onSessionEnd called.
    // On dispose failure we therefore leave manifest hooks registered
    // so a subsequent successful retry can still fire them.
    //
    // The wrapper uses a Proxy so live getters on the underlying
    // runtime (notably `sessionId`, which is a getter that changes
    // after `cycleSession()` or `rebindSessionId()`) are forwarded
    // through `Reflect.get` instead of being snapshotted by
    // object-spread. An object-spread wrapper would copy the value
    // of the sessionId getter at construction time and freeze it,
    // breaking every post-reset/rebind caller that later reads
    // `runtimeHandle.runtime.sessionId` to locate transcript or
    // checkpoint state for the current session.
    const engineDispose = runtime.dispose.bind(runtime);
    // Latch: manifest cleanup runs at most once across repeated
    // dispose() calls. The engine's own dispose() is a documented
    // no-op on second call; the wrapped dispose must preserve that
    // contract, otherwise retry/idempotent shutdown paths would
    // re-call `sink.close()` on an already-ended writer and throw.
    //
    // Tracking is per-hook rather than a single global flag: a
    // transient failure on one hook (e.g. a flaky audit flush)
    // must be retryable on the next dispose() while already-
    // successful hooks stay latched and do not re-run. A single
    // global flag would either:
    //   - mark cleanup done on any partial completion, silently
    //     dropping the failed hook forever (data loss), or
    //   - leave cleanup unmarked, re-running ALL hooks (including
    //     successful ones) and risking double-close on the
    //     already-ended writers.
    // Per-hook tracking gives precise retry semantics.
    const completedManifestHooks = new WeakSet<() => Promise<void> | void>();
    const wrappedDispose = async (): Promise<void> => {
      await engineDispose();
      // Fire manifest-middleware cleanup in reverse registration
      // order, skipping hooks that already ran successfully. Each
      // surviving hook is awaited so audit sinks' final flush +
      // writer.end() complete before dispose resolves.
      //
      // Cleanup failures are aggregated into a single error and
      // thrown after every unfinished hook has been attempted.
      // Audit and similar file-backed middleware treat finalization
      // as a correctness/security property: silently downgrading a
      // failed flush to a successful shutdown would let buffered
      // records never hit disk while the host reports success.
      // Hooks that succeed mid-pass are marked complete BEFORE the
      // throw so a retry dispose() re-runs only the ones that
      // failed.
      const hookErrors: unknown[] = [];
      for (const hook of [...manifestMiddlewareShutdownHooks].reverse()) {
        if (completedManifestHooks.has(hook)) {
          continue;
        }
        try {
          await hook();
          completedManifestHooks.add(hook);
        } catch (hookErr) {
          console.warn(
            `[koi/${hostId}] manifest-middleware shutdown hook failed during dispose: ${
              hookErr instanceof Error ? hookErr.message : String(hookErr)
            }`,
          );
          hookErrors.push(hookErr);
        }
      }
      // Drain any deferred per-child cleanup failures accumulated
      // while children were still running after a prior parent
      // dispose call. Each call to wrappedDispose resets the
      // accumulator so the same errors aren't surfaced twice on
      // repeated dispose attempts.
      const pendingChildErrors = childManifestCleanupFailures.splice(0);
      hookErrors.push(...pendingChildErrors);
      if (hookErrors.length > 0) {
        throw new AggregateError(
          hookErrors,
          `manifest-middleware shutdown had ${hookErrors.length} failure(s) during runtime.dispose ` +
            `(${pendingChildErrors.length} from per-child cleanup). Audit sinks or other file-backed cleanup may not have ` +
            "fully flushed — treat shutdown as failed and surface this error to the host's shutdown-reporting path. " +
            "A subsequent runtime.dispose() call will retry the failed parent hooks without re-running the ones that " +
            "already completed.",
        );
      }
    };
    const wrappedRuntime: typeof runtime = new Proxy(runtime, {
      get(target, prop, receiver): unknown {
        if (prop === "dispose") return wrappedDispose;
        return Reflect.get(target, prop, receiver);
      },
    });

    // Handle is about to be constructed and returned. Flip the flag
    // so the outer catch below treats a successful return as "ownership
    // transferred" and does NOT fire unwindManifestMiddlewareHooks.
    handleOwnershipTransferred = true;
    return {
      runtime: wrappedRuntime,
      checkpoint: checkpointHandle,
      transcript,
      sandboxActive,
      pluginSummary,
      governanceRules,
      governanceAlertThresholds: config.governanceAlertThresholds,
      governanceEnabled,
      violationStore,
      governanceBackend,
      createDecisionLedger: () =>
        createDecisionLedger({
          // The observability stack stores all trajectory data under a
          // fixed doc ID. When the stack is disabled, the ledger gets a
          // stub that reports empty — decision view shows nothing but
          // nothing breaks.
          trajectoryStore: {
            getDocument: () =>
              trajectoryStore !== undefined
                ? trajectoryStore.getDocument(trajectoryDocId)
                : Promise.resolve([]),
          },
          auditSink: ledgerAuditSink,
        }),
      getMcpStatus: async (): Promise<readonly McpServerStatus[]> => {
        // Merge user + plugin MCP resolvers — key by (source, name)
        // so duplicate names from different sources surface as
        // separate rows instead of hiding failures behind successes.
        const sources: {
          readonly label: string;
          readonly resolver: import("@koi/mcp").McpResolver;
          readonly transportMap: ReadonlyMap<string, "http" | "stdio" | "sse"> | undefined;
          readonly oauthNames: ReadonlySet<string> | undefined;
        }[] = [];
        if (mcpResolver !== undefined)
          sources.push({
            label: "user",
            resolver: mcpResolver,
            transportMap: mcpTransportByName,
            oauthNames: mcpOAuthCapableNames,
          });
        if (mcpPluginResolver !== undefined)
          sources.push({
            label: "plugin",
            resolver: mcpPluginResolver,
            transportMap: mcpPluginTransportByName,
            // Plugin servers authenticate via their own auth pseudo-tools, not
            // via nav:mcp-auth (which only handles .mcp.json entries). Force
            // hasOAuth false so AUTH_REQUIRED plugin servers render as error
            // rather than needs-auth, preventing a misleading recovery prompt.
            oauthNames: undefined,
          });
        if (sources.length === 0) return [];

        const entries: McpServerStatus[] = [];
        const seenByKey = new Set<string>();
        for (const { label, resolver, transportMap, oauthNames } of sources) {
          const toolCounts = new Map<string, number>();
          const descriptors = await resolver.discover();
          for (const d of descriptors) {
            const server = d.server ?? "unknown";
            toolCounts.set(server, (toolCounts.get(server) ?? 0) + 1);
          }
          for (const [name, count] of toolCounts) {
            // Always prefix non-user sources so nav:mcp-auth can detect them
            // reliably even in single-source (plugin-only) sessions.
            const displayName = label === "user" ? name : `${label}:${name}`;
            const key = `${label}:${name}`;
            if (seenByKey.has(key)) continue;
            seenByKey.add(key);
            entries.push({
              name: displayName,
              toolCount: count,
              failureCode: undefined,
              failureMessage: undefined,
              transport: transportMap?.get(name),
              hasOAuth: oauthNames?.has(name) ?? false,
            });
          }
          for (const f of resolver.failures) {
            if (toolCounts.has(f.serverName)) continue;
            const displayName = label === "user" ? f.serverName : `${label}:${f.serverName}`;
            const key = `${label}:${f.serverName}`;
            if (seenByKey.has(key)) continue;
            seenByKey.add(key);
            entries.push({
              name: displayName,
              toolCount: 0,
              failureCode: f.error.code,
              failureMessage: f.error.message,
              transport: transportMap?.get(f.serverName),
              hasOAuth: oauthNames?.has(f.serverName) ?? false,
            });
          }
        }
        return entries;
      },
      getTrajectorySteps: async () => {
        if (trajectoryStore === undefined) return [];
        const steps = await trajectoryStore.getDocument(trajectoryDocId);
        // Cap at MAX_TRAJECTORY_STEPS — return the most recent steps.
        return steps.length > MAX_TRAJECTORY_STEPS ? steps.slice(-MAX_TRAJECTORY_STEPS) : steps;
      },
      appendTrajectoryStep: async (step: RichTrajectoryStep): Promise<void> => {
        if (trajectoryStore === undefined) return;
        await trajectoryStore.append(trajectoryDocId, [step]);
      },
      resetSessionState: async (signal: AbortSignal, options?: { readonly truncate?: boolean }) => {
        // `truncate` signals the host's intent: `true` for destructive
        // boundaries like `/clear` or `/new` that wipe persisted state,
        // `false` (or omitted) for non-destructive resets like a picker
        // session switch or a post-rewind in-memory rebuild. Stacks
        // that hold per-session durable state (checkpoint chains)
        // gate destructive cleanup on this flag — pruning the chain
        // on a picker load or a successful rewind would silently
        // erase history the user explicitly opted to keep.
        const truncate = options?.truncate === true;
        // C4-A: Fail fast if caller forgot to abort the active run first.
        if (!signal.aborted) {
          throw new Error(
            "resetSessionState: active AbortSignal must be aborted before resetting. " +
              "Call controller.abort() first to cancel in-flight tool calls.",
          );
        }

        // 1. Cycle middleware session lifecycle BEFORE destructive cleanup.
        //    This awaits the in-flight run's settle (bounded by ~5s in the
        //    engine). On success the prior run is fully unwound. On settle
        //    timeout / onSessionEnd failure cycleSession throws — we
        //    propagate so callers surface a "restart required" error and
        //    the prior session stays inspectable. NO destructive cleanup
        //    has happened yet.
        //
        //    Capture the OLD sessionId before the cycle so we can clear
        //    the prior session's permission state below. cycleSession()
        //    rotates `runtime.sessionId`; reading it after rotation would
        //    target the empty new session and leak old approvals.
        const priorSessionId = runtime.sessionId;
        await runtime.cycleSession?.();

        // 2. Fire stack-contributed reset hooks. Each preset stack clears
        //    its own session-scoped state: observability prunes the
        //    trajectory store, memory wipes the backend, execution aborts
        //    the bgController, waits for subprocess drain, resets bash
        //    CWD, rotates the controller, and atomically swaps the task
        //    board. Run sequentially so failures stay isolated but
        //    ordered.
        //
        //    Collect errors from each hook instead of swallowing them.
        //    Every sibling still gets a chance to run (one wedged stack
        //    must not block the others) but a non-empty error list makes
        //    this function fail closed — the host catches the throw,
        //    flags the reset as unpersisted, and suppresses downstream
        //    affordances like the post-quit resume hint. Load-bearing
        //    for stacks whose state carries cross-boundary invariants:
        //    e.g. the checkpoint stack prunes the on-disk chain so
        //    `/rewind` after quit+resume cannot walk back into pre-
        //    clear snapshots; a swallowed prune failure would report
        //    `/clear` as successful while leaving the snapshots intact.
        //
        //    `resetContext.sessionId` is the LIVE runtime session id
        //    read at hook-call time. Callers may have invoked
        //    `runtime.rebindSessionId` between stack activation and
        //    reset (e.g. `koi tui` rebinds after `/rewind`), so a
        //    snapshot captured during activation is not safe here.
        const resetContext = {
          sessionId: runtime.sessionId as SessionId,
          truncate,
        } as const;
        const hookErrors: unknown[] = [];
        for (const hook of stackContribution.resetSessionHooks) {
          try {
            await hook(signal, resetContext);
          } catch (hookErr) {
            console.warn(
              `[koi/${hostId}] preset stack onResetSession hook failed: ${
                hookErr instanceof Error ? hookErr.message : String(hookErr)
              }`,
            );
            hookErrors.push(hookErr);
          }
        }

        // 3. Clear the OLD session's approval state (always-allow, caches,
        //    trackers). Not a stack concern — permissions is a core slot.
        //    Always runs even if a hook failed — approval state is cheap
        //    to clear and leaving it stale after a partial reset would
        //    leak cross-session grants.
        permMw.clearSessionApprovals(priorSessionId);

        // 4. If any hook failed, fail closed. `AggregateError` is the
        //    standard JS primitive for "multiple errors from sibling
        //    operations". The host's reset barrier catches this and
        //    flips `clearPersistFailed` so the post-quit resume hint
        //    is suppressed / the UI surfaces "reset may be incomplete".
        if (hookErrors.length > 0) {
          throw new AggregateError(
            hookErrors,
            `resetSessionState: ${hookErrors.length} preset stack reset hook(s) failed. ` +
              "Runtime state may be partially cleaned — host should flag this reset as unpersisted.",
          );
        }
      },
      hasActiveBackgroundTasks: () =>
        stackContribution.activeWorkPredicates.some((predicate) => predicate()),
      shutdownBackgroundTasks: () => {
        // Fire every stack's onShutdown hook and OR their "had live
        // work" return values. Execution stack aborts its bgController
        // and returns true when bash_background subprocesses were live;
        // other stacks currently contribute no shutdown hooks.
        let hadWork = false;
        for (const hook of stackContribution.shutdownHooks) {
          try {
            if (hook()) hadWork = true;
          } catch (hookErr) {
            console.warn(
              `[koi/${hostId}] preset stack onShutdown hook failed: ${
                hookErr instanceof Error ? hookErr.message : String(hookErr)
              }`,
            );
          }
        }
        // Manifest-middleware cleanup (audit sink close, etc.) is
        // deliberately NOT fired here. It runs on runtime.dispose()
        // AFTER the engine's onSessionEnd hooks complete, so audit
        // middleware's final `session_end` record is flushed to the
        // file before the writer is closed. shutdownBackgroundTasks
        // may be called before dispose (to drain bg work), which
        // would otherwise close the sink too early. See wrapping of
        // runtime.dispose above.
        // configHotReload is factory-bootstrap, not a stack feature —
        // dispose directly.
        configHotReload?.dispose();
        // Flush + close runtime-owned audit sink (opt-in via
        // config.auditNdjsonPath). Fire-and-forget because
        // shutdownBackgroundTasks is sync; any error is logged but does
        // not block shutdown. The process exits after this returns, so
        // the fire-and-forget close must complete synchronously relative
        // to the event loop before exit — createNdjsonAuditSink drains
        // its internal timer queue synchronously on close().
        if (auditMwForShutdown !== undefined) {
          const audit = auditMwForShutdown;
          void (async () => {
            try {
              await audit.flush();
              await audit.close();
            } catch (err) {
              console.warn(
                `[koi/${hostId}] audit shutdown failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          })();
        }
        if (auditSqliteMwForShutdown !== undefined) {
          const sqliteAudit = auditSqliteMwForShutdown;
          void (async () => {
            try {
              await sqliteAudit.flush();
              await sqliteAudit.close();
            } catch (err) {
              console.warn(
                `[koi/${hostId}] SQLite audit shutdown failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          })();
        }
        if (violationStore !== undefined) {
          try {
            violationStore.close();
          } catch (err) {
            console.warn(
              `[koi/${hostId}] ViolationStore shutdown failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        return hadWork;
      },
      getPendingReport: () => pendingReportText,
    };
  } catch (assemblyErr) {
    // Any failure between manifest resolution and the return above
    // leaks any audit sinks/writers created at resolution time.
    // Unwind the registered cleanup callbacks before rethrowing so
    // partially-constructed resources are released.
    if (!handleOwnershipTransferred) {
      await unwindManifestMiddlewareHooks();
    }
    throw assemblyErr;
  }
}

// ---------------------------------------------------------------------------
// Backward-compat aliases
//
// `tui-command.ts` imports `createTuiRuntime`, `TuiRuntimeConfig`, and
// `TuiRuntimeHandle`. The factory was renamed to `createKoiRuntime` /
// `KoiRuntimeConfig` / `KoiRuntimeHandle` because it now serves every
// host. These aliases keep the old names live.
// ---------------------------------------------------------------------------

export type TuiRuntimeConfig = KoiRuntimeConfig;
export type TuiRuntimeHandle = KoiRuntimeHandle;
/** @deprecated Use `createKoiRuntime` — kept for tui-command.ts compat. */
export const createTuiRuntime: (config: KoiRuntimeConfig) => Promise<KoiRuntimeHandle> =
  createKoiRuntime;
