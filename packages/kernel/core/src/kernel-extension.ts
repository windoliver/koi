/**
 * Kernel extension contract — pluggable L1 guard/lifecycle/assembly slots.
 *
 * Extensions allow composable, replaceable kernel behaviors without forking
 * createKoi(). Guard slots produce KoiMiddleware (sole interposition layer),
 * lifecycle validators gate state transitions, and assembly validators
 * verify component correctness before an agent starts.
 *
 * Exception: EXTENSION_PRIORITY constant is permitted in L0 as a pure
 * readonly data constant derived from L0 type definitions with zero logic.
 */

import type { AgentManifest } from "./assembly.js";
import type { Agent, ProcessState } from "./ecs.js";
import type { KoiMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Extension priority tiers
// ---------------------------------------------------------------------------

/**
 * Priority tiers for KernelExtension ordering.
 * Lower number = higher precedence (runs first / takes priority).
 * Order: Core > Platform > User > Addon.
 */
export const EXTENSION_PRIORITY: Readonly<{
  readonly CORE: 0;
  readonly PLATFORM: 10;
  readonly USER: 50;
  readonly ADDON: 100;
}> = Object.freeze({
  CORE: 0,
  PLATFORM: 10,
  USER: 50,
  ADDON: 100,
} as const);

// ---------------------------------------------------------------------------
// Guard context
// ---------------------------------------------------------------------------

/**
 * Context provided to a KernelExtension's guard slot at assembly time.
 * Guards use this to produce middleware tailored to the current agent.
 */
export interface GuardContext {
  /** Depth of the agent in the process tree (0 = root). */
  readonly agentDepth: number;
  /** The agent's manifest. */
  readonly manifest: AgentManifest;
  /** All attached components as a readonly map. */
  readonly components: ReadonlyMap<string, unknown>;
  /** The assembled agent entity (for GovernanceController lookup, etc.). */
  readonly agent?: Agent;
}

// ---------------------------------------------------------------------------
// Lifecycle transition context
// ---------------------------------------------------------------------------

/**
 * Context for lifecycle transition validation.
 * Validators receive the current and target states.
 */
export interface TransitionContext {
  /** Current process state before the transition. */
  readonly from: ProcessState;
  /** Target process state after the transition. */
  readonly to: ProcessState;
}

// ---------------------------------------------------------------------------
// Assembly validation
// ---------------------------------------------------------------------------

/** A single diagnostic produced by assembly validation. */
export interface ValidationDiagnostic {
  /** Name of the extension or validator that produced this diagnostic. */
  readonly source: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Severity: "error" blocks agent creation, "warning" is advisory. */
  readonly severity: "error" | "warning";
}

/** Result of assembly validation — discriminated union. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly ValidationDiagnostic[] };

// ---------------------------------------------------------------------------
// KernelExtension interface
// ---------------------------------------------------------------------------

/**
 * A composable kernel extension that plugs into L1 guard, lifecycle,
 * and assembly validation slots.
 *
 * All slots are optional — an extension can provide any combination.
 * Extensions are sorted by priority (ascending) before composition.
 */
export interface KernelExtension {
  /** Unique name for this extension (e.g., "koi:default-guards"). */
  readonly name: string;

  /**
   * Extension priority. Lower = higher precedence.
   * Defaults to EXTENSION_PRIORITY.USER (50) if omitted.
   */
  readonly priority?: number;

  /**
   * Guard slot — produces KoiMiddleware for the agent session.
   * Called once at assembly time. The returned middleware array is
   * composed into the agent's middleware chain.
   */
  readonly guards?: (
    ctx: GuardContext,
  ) => readonly KoiMiddleware[] | Promise<readonly KoiMiddleware[]>;

  /**
   * Lifecycle transition validator — sync only for hot-path performance.
   * Returns true to allow the transition, false to block it.
   * Only called for significant transitions (not wait/resume hot path).
   */
  readonly validateTransition?: (ctx: TransitionContext) => boolean;

  /**
   * Assembly validator — checks component/manifest correctness before
   * the agent starts running. Can be async for I/O-backed validation.
   * Return { ok: true } to pass, or { ok: false, diagnostics } to report issues.
   */
  readonly validateAssembly?: (
    components: ReadonlyMap<string, unknown>,
    manifest: AgentManifest,
  ) => ValidationResult | Promise<ValidationResult>;
}
