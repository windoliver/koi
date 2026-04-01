/**
 * BrickDescriptor for @koi/middleware-ace.
 *
 * Enables manifest auto-resolution: validates ACE config,
 * then creates the ACE middleware with in-memory stores by default.
 *
 * Store tracking happens inside createAceMiddleware() (via ace-stores.ts),
 * so both descriptor-created and direct-API middleware instances are tracked.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createAceMiddleware } from "./ace.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";

// Re-export from the shared module for public API continuity
export type { AceStores } from "./ace-stores.js";
export { getAceStores } from "./ace-stores.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAceDescriptorOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "ACE");
  if (!base.ok) return base;
  const opts = base.value;

  if (
    opts.maxInjectionTokens !== undefined &&
    (typeof opts.maxInjectionTokens !== "number" ||
      !Number.isFinite(opts.maxInjectionTokens) ||
      opts.maxInjectionTokens <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ace.maxInjectionTokens must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for ACE middleware.
 * Uses in-memory trajectory and playbook stores by default.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-ace",
  aliases: ["ace"],
  // No companionSkills here — the self-forge skill is attached via
  // createAceToolsProvider (only when forge tools are available).
  // Registering it on the descriptor would leak it globally to ALL
  // forge-enabled agents via registerCompanionSkills(), even non-ACE ones.
  optionsValidator: validateAceDescriptorOptions,
  factory(options, _context): KoiMiddleware {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const maxInjectionTokens =
      typeof options.maxInjectionTokens === "number" ? options.maxInjectionTokens : undefined;

    const config: Parameters<typeof createAceMiddleware>[0] = {
      trajectoryStore,
      playbookStore,
    };

    // createAceMiddleware() internally calls trackAceStores(),
    // so the stores are automatically accessible via getAceStores().
    return maxInjectionTokens !== undefined
      ? createAceMiddleware({ ...config, maxInjectionTokens })
      : createAceMiddleware(config);
  },
};
