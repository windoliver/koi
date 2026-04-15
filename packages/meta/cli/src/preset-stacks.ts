/**
 * Preset stack activation.
 *
 * Ported from v1's `activatePresetStacks()` pattern: each stack is a
 * named bundle of middleware + providers that a host can opt into via
 * config. The factory (`createKoiRuntime`) calls `activateStacks(ctx)`
 * at assembly time and splices the aggregated middleware into the
 * canonical composition via `MiddlewareCompositionInput.presetExtras`.
 *
 * Why presets instead of hardcoded wiring:
 *   - New features can be introduced as a stack without touching the
 *     core factory — contributors add a file under this pattern,
 *     register it in `DEFAULT_STACKS`, and it lights up for both
 *     hosts automatically.
 *   - Hosts with different security postures or resource budgets can
 *     opt into a subset (e.g. a CI runner might skip the checkpoint
 *     stack to avoid SQLite overhead).
 *   - The stack boundary makes it obvious which middleware belongs
 *     to which feature — no "is this event-trace's mw or the hook
 *     observer's?" archaeology when reading a trace.
 *
 * Current state: this file establishes the pattern and wires a
 * single placeholder stack so the mechanism is exercised end-to-end.
 * Migrating the currently-hardcoded features (observability, spawn,
 * memory, execution, etc.) into stacks is tracked as follow-up work
 * — the plumbing lands here so each migration is a local change.
 */

import type {
  ComponentProvider,
  KoiMiddleware,
  ModelAdapter,
  SessionId,
  SessionTranscript,
} from "@koi/core";
import type { CreateHookMiddlewareOptions } from "@koi/hooks";
import { checkpointStack } from "./preset-stacks/checkpoint.js";
import { executionStack } from "./preset-stacks/execution.js";
import { mcpStack } from "./preset-stacks/mcp.js";
import { memoryStack } from "./preset-stacks/memory.js";
import { notebookStack } from "./preset-stacks/notebook.js";
import { observabilityStack } from "./preset-stacks/observability.js";
import { rulesStack } from "./preset-stacks/rules.js";
import { skillsStack } from "./preset-stacks/skills.js";
import { spawnStack } from "./preset-stacks/spawn.js";

/**
 * Runtime-neutral context passed to every preset stack during activation.
 *
 * Additions to this interface should be backwards-compatible (optional
 * fields) so existing stacks don't break when the factory threads new
 * hooks through. Stacks that need host-specific state should read from
 * `host` (an opaque bag keyed by stack-chosen string keys) rather than
 * widening this interface.
 */
export interface StackActivationContext {
  /** Working directory — filesystem-scoped builders key off this. */
  readonly cwd: string;
  /** Stable host identifier (e.g. "koi-tui", "koi-cli"). */
  readonly hostId: string;
  /**
   * Model HTTP adapter — stacks that need to make single-shot model
   * calls (e.g. prompt-hook verification, semantic retry checks) read
   * this. Optional so lightweight unit tests can omit it.
   */
  readonly modelAdapter?: ModelAdapter | undefined;
  /**
   * Workspace-bound session transcript for stacks that need to persist
   * derived data alongside the session log (e.g. checkpoint stack
   * tracks rewind targets against the live transcript). `undefined`
   * when the host opts out of persistence (loop mode).
   */
  readonly sessionTranscript?: SessionTranscript | undefined;
  /**
   * Host-specific opaque context. Stacks that care about a particular
   * host state (skillsRuntime, approvalHandler, etc.) read a
   * well-known string key defined next to the stack's source.
   */
  readonly host?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The bundle a stack contributes to the runtime assembly.
 *
 * All fields beyond `middleware`/`providers` are optional — a pure
 * tool bundle like `notebookStack` returns only those two and leaves
 * the rest undefined. Stacks with cross-cutting state (observability,
 * execution, memory) opt into the lifecycle / export fields.
 */
export interface StackContribution {
  /**
   * Middleware layers appended to the canonical compose order at the
   * `presetExtras` slot (between the core chain and the innermost
   * system-prompt / session-transcript layer). Order within the list
   * is stack-internal — stacks are expected to be order-independent
   * with respect to each other.
   */
  readonly middleware: readonly KoiMiddleware[];
  /** Component providers (tools, resolvers) registered with createKoi. */
  readonly providers: readonly ComponentProvider[];
  /**
   * Extras merged into the host-built `createHookMiddleware` options
   * (e.g. an `onExecuted` observer tap that the observability stack
   * registers so hook executions land in the trajectory store).
   * Stack-contributed hookExtras are merged with the host's own
   * extras — the host still owns the hook list itself.
   */
  readonly hookExtras?: Partial<Omit<CreateHookMiddlewareOptions, "hooks">> | undefined;
  /**
   * Typed exports keyed by well-known string keys. The factory reads
   * these to populate the returned `KoiRuntimeHandle` (e.g. the
   * checkpoint stack exports `checkpointHandle`, the observability
   * stack exports `trajectoryStore` + `getTrajectorySteps`, the
   * execution stack exports `bashHandle` for resetCwd). Each stack
   * documents its export keys next to its source.
   */
  readonly exports?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Hook fired inside `KoiRuntimeHandle.resetSessionState` after the
   * caller aborts the active signal. Stacks clear their session-scoped
   * state here (bash cwd, bg controller rotation, memory backend wipe,
   * trajectory store prune, approval cache clear). Called sequentially
   * in registration order.
   *
   * `resetContext.sessionId` is the CURRENT runtime session id, read
   * at hook-call time — not a snapshot from stack activation. Stacks
   * that reset per-session state (checkpoint prunes the chain keyed
   * on this id) MUST read it from the parameter, because hosts can
   * call `runtime.rebindSessionId(...)` between activation and
   * reset (e.g. `koi tui` does this after `/rewind`). A snapshot
   * captured during activation would target a stale id and leave
   * the live session's state intact.
   *
   * Thrown errors propagate out of `resetSessionState` as an
   * `AggregateError` after all siblings have had a chance to run —
   * `/clear` fails closed and surfaces the error to the caller.
   */
  readonly onResetSession?:
    | ((
        signal: AbortSignal,
        resetContext: {
          readonly sessionId: SessionId;
          readonly truncate: boolean;
        },
      ) => Promise<void> | void)
    | undefined;
  /**
   * Hook fired inside `KoiRuntimeHandle.shutdownBackgroundTasks`.
   * Returns `true` if the stack had live work that needed aborting —
   * the factory ORs the results so the caller knows whether to wait
   * for the SIGKILL escalation window before exiting.
   */
  readonly onShutdown?: (() => boolean) | undefined;
  /**
   * Reports whether this stack currently has active background work
   * (e.g. in-flight bash_background subprocesses). The factory ORs
   * across all stacks to produce `hasActiveBackgroundTasks`.
   */
  readonly hasActiveWork?: (() => boolean) | undefined;
}

/**
 * Activation phase for a preset stack.
 *
 * - `"early"` (default) — runs BEFORE the factory builds its core
 *   middleware (permissions, hook, system-prompt, session-transcript).
 *   Early stacks can contribute `hookExtras` (e.g. observability's
 *   observer tap) and export state the factory reads (trajectoryStore,
 *   bashHandle, checkpointHandle).
 * - `"late"` — runs AFTER the core middleware is assembled. Late
 *   stacks read the already-built middleware from the context's
 *   `host` bag under the `LATE_PHASE_HOST_KEYS` names, so features
 *   that need cross-cutting references (spawn's `inheritedMiddleware`
 *   for child agent policy propagation) can compose cleanly.
 */
export type StackPhase = "early" | "late";

/** A preset stack definition. */
export interface PresetStack {
  /** Stable stack id — used for opt-out config and trace labelling. */
  readonly id: string;
  /** Short human description — shown in `--debug` runtime dumps. */
  readonly description: string;
  /**
   * Activation phase. Omit or set to `"early"` for the default pass.
   * Late-phase stacks need references to already-composed middleware.
   */
  readonly phase?: StackPhase | undefined;
  /** Assemble this stack's contribution for the given context. */
  readonly activate: (
    ctx: StackActivationContext,
  ) => Promise<StackContribution> | StackContribution;
}

/**
 * Well-known keys used by late-phase stacks to read built middleware
 * from `ctx.host`. The factory populates these after running the
 * early-phase activation and building its core middleware.
 */
export const LATE_PHASE_HOST_KEYS = {
  /** The already-composed inherited middleware for spawn child agents. */
  inheritedMiddleware: "inheritedMiddleware",
  /**
   * Async callback that the spawn preset stack invokes once per
   * spawned child to get a fresh set of middleware instances.
   * Used by the runtime factory to re-resolve manifest-declared
   * middleware per child so each child gets its own per-session
   * state (audit queue + hash chain + lifecycle hooks) rather
   * than sharing the parent's mutable middleware instances.
   *
   * Shape:
   *   (childCtx: { parentSessionId, parentAgentId }) => Promise<KoiMiddleware[]>
   *
   * When absent, children inherit only the static security +
   * system-prompt layers from `inheritedMiddleware`.
   */
  perChildManifestMiddlewareFactory: "perChildManifestMiddlewareFactory",
} as const;

/**
 * The default stack registry. New features register a `PresetStack`
 * here and both hosts pick it up without factory edits.
 *
 * Each entry is a self-contained feature bundle that activates via
 * `activateStacks`. Hosts opt into a subset by passing
 * `{enabled: new Set(["notebook", "rules", ...])}`. Omitting the
 * `enabled` option activates every stack.
 */
export const DEFAULT_STACKS: readonly PresetStack[] = [
  // Observability first: its `onExecuted` tap must be collected before
  // the factory builds the main hook middleware so hook executions
  // land in the trajectory store from the first dispatch.
  observabilityStack,
  // Execution next: exports `bashHandle` which the factory reads to
  // pass `bashTool` into `buildCoreProviders`. Activating this stack
  // before the others keeps the factory's read-after-activate
  // ordering trivial.
  executionStack,
  checkpointStack,
  memoryStack,
  mcpStack,
  notebookStack,
  rulesStack,
  skillsStack,
  // Late-phase: spawn needs already-composed middleware for child
  // inheritance. The factory runs two `activateStacks` passes —
  // early (everything above) then late (spawn) — populating
  // `ctx.host[LATE_PHASE_HOST_KEYS.inheritedMiddleware]` in between.
  spawnStack,
];

/**
 * Merge two `ActivatedStacks` aggregates (early + late phase) into one.
 *
 * Ordering: early contributions come first within each list, late
 * second. Exports are merged with late keys overriding early keys on
 * conflict (late phase sees the fully-assembled runtime so its view
 * is canonical if a key collides). Observability's `onExecuted` tap
 * is always early-phase, so the late-phase `hookExtras` contribution
 * is ignored here — merging observer taps across phases would
 * require rebuilding the hook middleware, which defeats the point
 * of a late phase.
 */
export function mergeStackContributions(
  early: ActivatedStacks,
  late: ActivatedStacks,
): ActivatedStacks {
  return {
    middleware: [...early.middleware, ...late.middleware],
    providers: [...early.providers, ...late.providers],
    hookExtras: early.hookExtras,
    exports: { ...early.exports, ...late.exports },
    resetSessionHooks: [...early.resetSessionHooks, ...late.resetSessionHooks],
    shutdownHooks: [...early.shutdownHooks, ...late.shutdownHooks],
    activeWorkPredicates: [...early.activeWorkPredicates, ...late.activeWorkPredicates],
  };
}

/**
 * The aggregated output of `activateStacks`. All per-stack contributions
 * are collected into sideband fields the factory reads for lifecycle
 * orchestration and handle population.
 */
export interface ActivatedStacks {
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  /**
   * Merged hookExtras — the factory folds these into its own
   * `createHookMiddleware` options before building the hook middleware.
   * Currently only `onExecuted` is composed (multiple observer taps
   * become a single wrapping function).
   */
  readonly hookExtras: Partial<Omit<CreateHookMiddlewareOptions, "hooks">>;
  /**
   * Flat map of every stack export keyed by its well-known string key.
   * Later stacks can overwrite earlier ones if they declare the same
   * key — the `activateStacks` activation order (matching
   * `DEFAULT_STACKS`) determines precedence.
   */
  readonly exports: Readonly<Record<string, unknown>>;
  /** All `onResetSession` hooks in activation order. */
  readonly resetSessionHooks: readonly ((
    signal: AbortSignal,
    resetContext: {
      readonly sessionId: SessionId;
      readonly truncate: boolean;
    },
  ) => Promise<void> | void)[];
  /** All `onShutdown` hooks in activation order. */
  readonly shutdownHooks: readonly (() => boolean)[];
  /** All `hasActiveWork` predicates in activation order. */
  readonly activeWorkPredicates: readonly (() => boolean)[];
}

/**
 * Activate the selected stacks and return the aggregated contribution.
 *
 * `enabled` filters by stack id — callers pass `undefined` (default)
 * to activate every stack in the registry, or a set of ids to opt
 * into a subset. `phase` filters by stack phase; omitting it activates
 * every phase. Stacks are activated sequentially so activation side
 * effects (filesystem creation, resolver registration) happen in a
 * deterministic order.
 *
 * Callers that split activation across phases pass the same `enabled`
 * set on every call so a user's `manifest.stacks: [foo, bar]` opt-in
 * applies consistently regardless of which phase a stack lives in.
 */
export async function activateStacks(
  ctx: StackActivationContext,
  options?: {
    readonly stacks?: readonly PresetStack[];
    readonly enabled?: ReadonlySet<string>;
    readonly phase?: StackPhase | undefined;
  },
): Promise<ActivatedStacks> {
  const stacks = options?.stacks ?? DEFAULT_STACKS;
  const enabled = options?.enabled;
  const phase = options?.phase;
  const middleware: KoiMiddleware[] = [];
  const providers: ComponentProvider[] = [];
  const exports: Record<string, unknown> = {};
  const resetSessionHooks: ((
    signal: AbortSignal,
    resetContext: {
      readonly sessionId: SessionId;
      readonly truncate: boolean;
    },
  ) => Promise<void> | void)[] = [];
  const shutdownHooks: (() => boolean)[] = [];
  const activeWorkPredicates: (() => boolean)[] = [];
  // Collected observer taps from stack hookExtras. Multiple observers
  // are composed into one function so the host can pass a single
  // `onExecuted` to `createHookMiddleware`.
  const onExecutedTaps: NonNullable<CreateHookMiddlewareOptions["onExecuted"]>[] = [];

  for (const stack of stacks) {
    if (enabled !== undefined && !enabled.has(stack.id)) continue;
    const stackPhase: StackPhase = stack.phase ?? "early";
    if (phase !== undefined && stackPhase !== phase) continue;
    const contribution = await stack.activate(ctx);
    middleware.push(...contribution.middleware);
    providers.push(...contribution.providers);
    if (contribution.exports !== undefined) {
      Object.assign(exports, contribution.exports);
    }
    if (contribution.onResetSession !== undefined) {
      resetSessionHooks.push(contribution.onResetSession);
    }
    if (contribution.onShutdown !== undefined) {
      shutdownHooks.push(contribution.onShutdown);
    }
    if (contribution.hasActiveWork !== undefined) {
      activeWorkPredicates.push(contribution.hasActiveWork);
    }
    if (contribution.hookExtras?.onExecuted !== undefined) {
      onExecutedTaps.push(contribution.hookExtras.onExecuted);
    }
  }

  // Compose multiple observer taps into one. Error isolation: one
  // failing tap must not block the others.
  const hookExtras: Partial<Omit<CreateHookMiddlewareOptions, "hooks">> =
    onExecutedTaps.length === 0
      ? {}
      : {
          onExecuted: (results, event) => {
            for (const tap of onExecutedTaps) {
              try {
                tap(results, event);
              } catch {
                /* observer taps are fire-and-forget; swallow to protect siblings */
              }
            }
          },
        };

  return {
    middleware,
    providers,
    hookExtras,
    exports,
    resetSessionHooks,
    shutdownHooks,
    activeWorkPredicates,
  };
}
