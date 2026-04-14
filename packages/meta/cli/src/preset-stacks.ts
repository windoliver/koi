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

import type { ComponentProvider, KoiMiddleware } from "@koi/core";

/**
 * Runtime-neutral context passed to every preset stack during activation.
 *
 * Additions to this interface should be backwards-compatible (optional
 * fields) so existing stacks don't break when the factory threads new
 * hooks through. Stacks that need host-specific state should read from
 * `host` (an opaque bag keyed by `hostId`) rather than widening this
 * interface.
 */
export interface StackActivationContext {
  /** Working directory — filesystem-scoped builders key off this. */
  readonly cwd: string;
  /** Stable host identifier (e.g. "koi-tui", "koi-cli"). */
  readonly hostId: string;
  /**
   * Host-specific opaque context. Stacks that care about a particular
   * host read a well-known key (`host["koi-tui:trajectoryStore"]`).
   * Stacks that are host-neutral ignore this entirely.
   */
  readonly host?: Readonly<Record<string, unknown>> | undefined;
}

/** The bundle a stack contributes to the runtime assembly. */
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
}

/** A preset stack definition. */
export interface PresetStack {
  /** Stable stack id — used for opt-out config and trace labelling. */
  readonly id: string;
  /** Short human description — shown in `--debug` runtime dumps. */
  readonly description: string;
  /** Assemble this stack's contribution for the given context. */
  readonly activate: (
    ctx: StackActivationContext,
  ) => Promise<StackContribution> | StackContribution;
}

/**
 * The default stack registry. New features register a `PresetStack`
 * here and both hosts pick it up without factory edits.
 *
 * Currently empty — the factory still wires observability, checkpoint,
 * spawn, memory, etc. inline. Follow-up PRs migrate each feature into
 * its own stack file and append here; the mechanism is already wired
 * through `createKoiRuntime` → `composeRuntimeMiddleware.presetExtras`
 * so each migration is a drop-in change.
 */
export const DEFAULT_STACKS: readonly PresetStack[] = [];

/**
 * Activate the selected stacks and return the aggregated contribution.
 *
 * `enabled` filters by stack id — callers pass `undefined` (default)
 * to activate every stack in the registry, or a set of ids to opt
 * into a subset. Stacks are activated sequentially so activation
 * side effects (filesystem creation, resolver registration) happen
 * in a deterministic order.
 */
export async function activateStacks(
  ctx: StackActivationContext,
  options?: {
    readonly stacks?: readonly PresetStack[];
    readonly enabled?: ReadonlySet<string>;
  },
): Promise<StackContribution> {
  const stacks = options?.stacks ?? DEFAULT_STACKS;
  const enabled = options?.enabled;
  const middleware: KoiMiddleware[] = [];
  const providers: ComponentProvider[] = [];
  for (const stack of stacks) {
    if (enabled !== undefined && !enabled.has(stack.id)) continue;
    const contribution = await stack.activate(ctx);
    middleware.push(...contribution.middleware);
    providers.push(...contribution.providers);
  }
  return { middleware, providers };
}
