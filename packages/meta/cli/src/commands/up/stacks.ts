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
): Promise<void> {
  if (config.forgeBootstrap === undefined) return;
  const { createAutoHarnessStack } = await import("@koi/auto-harness");
  const harnessStack = createAutoHarnessStack({
    forgeStore: config.forgeBootstrap.store as never,
    generate: async () => "",
  });
  middleware.push(harnessStack.policyCacheMiddleware);
  log(config, "Stack: auto-harness (policy cache active)");
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
    await tryActivate("auto-harness", () => activateAutoHarness(config, middleware));
  }

  if (config.stacks.governance === true) {
    await tryActivate("governance", () =>
      activateGovernance(config, middleware, providers, disposables),
    );
  }

  if (config.stacks.contextArena === true) {
    await tryActivate("context-arena", () => activateContextArena(config, middleware, providers));
  }

  // goalStack and qualityGate are reserved for future L3 packages.
  // When @koi/goal-stack and @koi/quality-gate are implemented,
  // add activation branches here following the same pattern.

  return { middleware, providers, disposables };
}
