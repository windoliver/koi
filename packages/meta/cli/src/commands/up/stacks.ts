/**
 * L3 stack activation — dynamically imports and creates stacks
 * based on PresetStacks flags.
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Activates L3 middleware stacks based on preset flags.
 *
 * Each stack is dynamically imported only when enabled, keeping
 * the cold-start minimal for presets that don't use them.
 */
export async function activatePresetStacks(
  config: StackActivationConfig,
): Promise<ActivatedStacks> {
  const middleware: KoiMiddleware[] = [];
  const providers: ComponentProvider[] = [];
  const disposables: (() => Promise<void> | void)[] = [];

  // Tool stack (audit, limits, dedup, sandbox, selection, variant failover)
  if (config.stacks.toolStack === true) {
    try {
      const { createToolStack } = await import("@koi/tool-stack");
      const toolBundle = createToolStack();
      middleware.push(...toolBundle.middleware);
      if (config.verbose) {
        process.stderr.write(
          `  Stack: tool-stack (${String(toolBundle.middleware.length)} middleware)\n`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.verbose) process.stderr.write(`  warn: tool-stack failed: ${message}\n`);
    }
  }

  // Retry stack (fs-rollback, semantic-retry, guided-retry)
  if (config.stacks.retryStack === true) {
    try {
      const { createRetryStack } = await import("@koi/retry-stack");
      const retryBundle = createRetryStack({});
      middleware.push(...retryBundle.middleware);
      if (config.verbose) {
        process.stderr.write(
          `  Stack: retry-stack (${String(retryBundle.middleware.length)} middleware)\n`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.verbose) process.stderr.write(`  warn: retry-stack failed: ${message}\n`);
    }
  }

  // Auto-harness (policy cache + synthesis loop)
  if (config.stacks.autoHarness === true && config.forgeBootstrap !== undefined) {
    try {
      const { createAutoHarnessStack } = await import("@koi/auto-harness");
      const harnessStack = createAutoHarnessStack({
        forgeStore: config.forgeBootstrap.store as never,
        generate: async () => "",
      });
      middleware.push(harnessStack.policyCacheMiddleware);
      if (config.verbose) {
        process.stderr.write("  Stack: auto-harness (policy cache active)\n");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.verbose) process.stderr.write(`  warn: auto-harness failed: ${message}\n`);
    }
  }

  return { middleware, providers, disposables };
}
