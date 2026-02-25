/**
 * Extension composer — sorts, merges, and composes KernelExtension slots
 * into a single ComposedExtensions value for use by createKoi().
 *
 * Also provides createDefaultGuardExtension() which wraps the existing
 * 3 L1 guards (iteration, loop, spawn) as a KernelExtension for dogfooding.
 */

import type {
  AgentManifest,
  GuardContext,
  KernelExtension,
  KoiMiddleware,
  ProcessState,
  TransitionContext,
  ValidationDiagnostic,
  ValidationResult,
} from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import { createIterationGuard, createLoopDetector, createSpawnGuard } from "./guards.js";
import type { IterationLimits, LoopDetectionConfig, SpawnPolicy } from "./types.js";

// ---------------------------------------------------------------------------
// Significant transitions (validator is called)
// ---------------------------------------------------------------------------

/**
 * Significant transitions — lifecycle validator is only invoked for these.
 * Running↔waiting is the hot path (model calls, tool calls) and is skipped.
 */
const SIGNIFICANT_TRANSITIONS: ReadonlySet<string> = new Set([
  "created→running",
  "created→terminated",
  "running→suspended",
  "running→terminated",
  "waiting→suspended",
  "waiting→terminated",
  "suspended→running",
  "suspended→terminated",
]);

/** Check if a transition is significant (should invoke validators). O(1) set lookup. */
export function isSignificantTransition(from: ProcessState, to: ProcessState): boolean {
  return SIGNIFICANT_TRANSITIONS.has(`${from}→${to}`);
}

// ---------------------------------------------------------------------------
// ComposedExtensions
// ---------------------------------------------------------------------------

/** Sync validator for lifecycle transitions. Used by AgentEntity. */
export type TransitionValidator = (from: ProcessState, to: ProcessState) => boolean;

/** The composed result of all KernelExtension slots, ready for use by createKoi(). */
export interface ComposedExtensions {
  /** All guard middleware produced by extensions, sorted by extension priority. */
  readonly guardMiddleware: readonly KoiMiddleware[];
  /** Composed lifecycle transition validator (AND-logic, sync). */
  readonly validateTransition: (from: ProcessState, to: ProcessState) => boolean;
  /** Composed assembly validator (parallel execution, merged diagnostics). */
  readonly validateAssembly: (
    components: ReadonlyMap<string, unknown>,
    manifest: AgentManifest,
  ) => Promise<ValidationResult>;
}

// ---------------------------------------------------------------------------
// composeExtensions
// ---------------------------------------------------------------------------

/**
 * Sort, merge, and compose all KernelExtension slots into a single
 * ComposedExtensions value.
 *
 * - Extensions are sorted by priority ascending (lower = runs first).
 * - Guard slots produce middleware arrays that are concatenated in priority order.
 * - Transition validators are composed with AND logic (short-circuit on false).
 * - Assembly validators run in parallel via Promise.all, diagnostics merged.
 */
export async function composeExtensions(
  extensions: readonly KernelExtension[],
  guardCtx: GuardContext,
): Promise<ComposedExtensions> {
  // 1. Sort by priority ascending (stable sort, default USER=50)
  const sorted = [...extensions].sort(
    (a, b) => (a.priority ?? EXTENSION_PRIORITY.USER) - (b.priority ?? EXTENSION_PRIORITY.USER),
  );

  // 2. Collect guard middleware from each extension (in priority order)
  const allGuardMiddleware: KoiMiddleware[] = [];
  for (const ext of sorted) {
    if (ext.guards !== undefined) {
      const produced = await ext.guards(guardCtx);
      for (const mw of produced) {
        allGuardMiddleware.push(mw);
      }
    }
  }

  // 3. Collect transition validators → compose into AND-logic
  const transitionValidators: readonly ((ctx: TransitionContext) => boolean)[] = sorted
    .filter(
      (
        ext,
      ): ext is KernelExtension & {
        readonly validateTransition: (ctx: TransitionContext) => boolean;
      } => ext.validateTransition !== undefined,
    )
    .map((ext) => ext.validateTransition);

  const composedTransitionValidator = (from: ProcessState, to: ProcessState): boolean => {
    // Skip non-significant transitions (wait/resume hot path)
    if (!isSignificantTransition(from, to)) {
      return true;
    }
    const ctx: TransitionContext = { from, to };
    // AND-logic: short-circuit on first false
    for (const validator of transitionValidators) {
      if (!validator(ctx)) {
        return false;
      }
    }
    return true;
  };

  // 4. Collect assembly validators → compose into parallel execution
  const assemblyValidators = sorted.filter(
    (
      ext,
    ): ext is KernelExtension & {
      readonly validateAssembly: (
        components: ReadonlyMap<string, unknown>,
        manifest: AgentManifest,
      ) => ValidationResult | Promise<ValidationResult>;
    } => ext.validateAssembly !== undefined,
  );

  const composedAssemblyValidator = async (
    components: ReadonlyMap<string, unknown>,
    manifest: AgentManifest,
  ): Promise<ValidationResult> => {
    if (assemblyValidators.length === 0) {
      return { ok: true };
    }

    const results = await Promise.all(
      assemblyValidators.map((ext) => ext.validateAssembly(components, manifest)),
    );

    const allDiagnostics: ValidationDiagnostic[] = [];
    for (const result of results) {
      if (!result.ok) {
        for (const diag of result.diagnostics) {
          allDiagnostics.push(diag);
        }
      }
    }

    if (allDiagnostics.some((d) => d.severity === "error")) {
      return { ok: false, diagnostics: allDiagnostics };
    }

    if (allDiagnostics.length > 0) {
      // Warnings only — still ok but carry diagnostics
      // Return ok: true since no errors, warnings are advisory
      return { ok: true };
    }

    return { ok: true };
  };

  return {
    guardMiddleware: allGuardMiddleware,
    validateTransition: composedTransitionValidator,
    validateAssembly: composedAssemblyValidator,
  };
}

// ---------------------------------------------------------------------------
// Default guard extension config
// ---------------------------------------------------------------------------

/** Configuration for the default guard extension (wraps existing L1 guards). */
export interface DefaultGuardExtensionConfig {
  /** Iteration limits. Defaults to DEFAULT_ITERATION_LIMITS. */
  readonly limits?: Partial<IterationLimits>;
  /** Loop detection config. Set to false to disable. */
  readonly loopDetection?: Partial<LoopDetectionConfig> | false;
  /** Spawn policy. Defaults to DEFAULT_SPAWN_POLICY. */
  readonly spawn?: Partial<SpawnPolicy>;
}

// ---------------------------------------------------------------------------
// createDefaultGuardExtension
// ---------------------------------------------------------------------------

/**
 * Wraps the existing 3 L1 guards (iteration, loop, spawn) as a
 * KernelExtension at CORE priority (0) for dogfooding.
 *
 * This is the default extension created by createKoi() when sugar fields
 * (limits, loopDetection, spawn) are used.
 */
export function createDefaultGuardExtension(config?: DefaultGuardExtensionConfig): KernelExtension {
  return {
    name: "koi:default-guards",
    priority: EXTENSION_PRIORITY.CORE,

    guards: (ctx: GuardContext): readonly KoiMiddleware[] => {
      const guards: KoiMiddleware[] = [createIterationGuard(config?.limits ?? undefined)];

      if (config?.loopDetection !== false) {
        const loopConfig = config?.loopDetection;
        guards.push(createLoopDetector(loopConfig === undefined ? undefined : loopConfig));
      }

      guards.push(
        createSpawnGuard({
          ...(config?.spawn !== undefined ? { policy: config.spawn } : {}),
          agentDepth: ctx.agentDepth,
          ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
        }),
      );

      return guards;
    },
  };
}
