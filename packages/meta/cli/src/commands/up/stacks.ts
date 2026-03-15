/**
 * L3 stack activation — dynamically imports and creates stacks
 * based on PresetStacks flags.
 *
 * Each stack is dynamically imported only when enabled, keeping
 * the cold-start minimal for presets that don't use them.
 */

import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import type { PresetStacks } from "@koi/runtime-presets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivatedStacks {
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly disposables: readonly (() => Promise<void> | void)[];
  /**
   * Auto-harness outputs for forge synthesis wiring.
   * When present, `synthesizeHarness` should be passed to the forge
   * middleware stack so failure-driven demand signals trigger the full
   * synthesis loop. Requires ForgeBootstrapConfig.synthesizeHarness
   * support (tracked separately).
   */
  readonly autoHarness?: {
    readonly synthesizeHarness: (
      signal: import("@koi/core").ForgeDemandSignal,
    ) => Promise<import("@koi/core").BrickArtifact | null>;
    readonly maxSynthesesPerSession: number;
    readonly policyCacheHandle: unknown;
  };
}

export interface StackActivationConfig {
  readonly stacks: PresetStacks;
  readonly forgeBootstrap:
    | {
        readonly store: unknown;
        readonly runtime: unknown;
      }
    | undefined;
  readonly verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Per-stack activators (each non-fatal)
// ---------------------------------------------------------------------------

function log(config: StackActivationConfig, msg: string): void {
  if (config.verbose) process.stderr.write(`  ${msg}\n`);
}

async function activateToolStack(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<void> {
  const { createToolStack } = await import("@koi/tool-stack");
  const bundle = createToolStack();
  middleware.push(...bundle.middleware);
  log(config, `Stack: tool-stack (${String(bundle.middleware.length)} middleware)`);
}

async function activateRetryStack(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<void> {
  const { createRetryStack } = await import("@koi/retry-stack");
  const bundle = createRetryStack({});
  middleware.push(...bundle.middleware);
  log(config, `Stack: retry-stack (${String(bundle.middleware.length)} middleware)`);
}

async function activateAutoHarness(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
): Promise<ActivatedStacks["autoHarness"]> {
  if (config.forgeBootstrap === undefined) return undefined;
  const { createAutoHarnessStack } = await import("@koi/auto-harness");
  const harnessStack = createAutoHarnessStack({
    forgeStore: config.forgeBootstrap.store as never,
    generate: async () => "",
  });
  middleware.push(harnessStack.policyCacheMiddleware);
  log(config, "Stack: auto-harness (policy cache + synthesis loop active)");
  return {
    synthesizeHarness: harnessStack.synthesizeHarness,
    maxSynthesesPerSession: harnessStack.maxSynthesesPerSession,
    policyCacheHandle: harnessStack.policyCacheHandle,
  };
}

async function activateGovernance(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
  providers: ComponentProvider[],
  disposables: (() => Promise<void> | void)[],
): Promise<void> {
  const { createGovernanceStack } = await import("@koi/governance");
  const bundle = createGovernanceStack({});
  middleware.push(...bundle.middlewares);
  providers.push(...bundle.providers);
  for (const d of bundle.disposables) {
    disposables.push(() => d[Symbol.dispose]());
  }
  log(config, `Stack: governance (${String(bundle.middlewares.length)} middleware)`);
}

async function activateContextArena(
  config: StackActivationConfig,
  middleware: KoiMiddleware[],
  providers: ComponentProvider[],
): Promise<void> {
  const { createContextArena } = await import("@koi/context-arena");
  const bundle = await createContextArena({});
  middleware.push(...bundle.middleware);
  providers.push(...bundle.providers);
  log(config, `Stack: context-arena (${String(bundle.middleware.length)} middleware)`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Activates L3 middleware stacks based on preset flags.
 */
export async function activatePresetStacks(
  config: StackActivationConfig,
): Promise<ActivatedStacks> {
  const middleware: KoiMiddleware[] = [];
  const providers: ComponentProvider[] = [];
  const disposables: (() => Promise<void> | void)[] = [];
  // let justified: captured from auto-harness activation for forge wiring
  let autoHarnessResult: ActivatedStacks["autoHarness"];

  const tryActivate = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.verbose) process.stderr.write(`  warn: ${name} failed: ${message}\n`);
    }
  };

  if (config.stacks.toolStack === true) {
    await tryActivate("tool-stack", () => activateToolStack(config, middleware));
  }

  if (config.stacks.retryStack === true) {
    await tryActivate("retry-stack", () => activateRetryStack(config, middleware));
  }

  if (config.stacks.autoHarness === true) {
    try {
      autoHarnessResult = await activateAutoHarness(config, middleware);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.verbose) process.stderr.write(`  warn: auto-harness failed: ${message}\n`);
    }
  }

  if (config.stacks.governance === true) {
    await tryActivate("governance", () =>
      activateGovernance(config, middleware, providers, disposables),
    );
  }

  if (config.stacks.contextArena === true) {
    await tryActivate("context-arena", () => activateContextArena(config, middleware, providers));
  }

  if (config.stacks.goalStack === true) {
    await tryActivate("goal-stack", async () => {
      const { createGoalStack } = await import("@koi/goal-stack");
      const bundle = createGoalStack({});
      middleware.push(...bundle.middlewares);
      providers.push(...bundle.providers);
      log(config, `Stack: goal-stack (${String(bundle.middlewares.length)} middleware)`);
    });
  }

  if (config.stacks.qualityGate === true) {
    await tryActivate("quality-gate", async () => {
      const { createQualityGate } = await import("@koi/quality-gate");
      const bundle = createQualityGate({});
      middleware.push(...bundle.middleware);
      log(config, `Stack: quality-gate (${String(bundle.middleware.length)} middleware)`);
    });
  }

  return { middleware, providers, disposables, autoHarness: autoHarnessResult };
}
