/**
 * BrickDescriptor for @koi/middleware-ace.
 *
 * Enables manifest auto-resolution: validates ACE config,
 * then creates the ACE middleware with in-memory stores by default.
 *
 * Stores are tracked via a WeakMap so the L3 wiring can retrieve them
 * and create the ACE tools provider with the same store instances.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createAceMiddleware } from "./ace.js";
import { SELF_FORGE_SKILL } from "./self-forge-skill.js";
import type { PlaybookStore, StructuredPlaybookStore } from "./stores.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";

// ---------------------------------------------------------------------------
// Store accessor — lets L3 code retrieve stores from a descriptor-created
// middleware without exposing internals on the middleware interface.
// WeakMap ensures no memory leaks (middleware GC → entry removed).
// ---------------------------------------------------------------------------

export interface AceStores {
  readonly playbookStore: PlaybookStore;
  readonly structuredPlaybookStore?: StructuredPlaybookStore | undefined;
}

const middlewareStores = new WeakMap<KoiMiddleware, AceStores>();

/**
 * Retrieve the stores associated with an ACE middleware created by the descriptor.
 * Returns undefined if the middleware wasn't created by this descriptor.
 */
export function getAceStores(middleware: KoiMiddleware): AceStores | undefined {
  return middlewareStores.get(middleware);
}

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
  companionSkills: [SELF_FORGE_SKILL],
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

    const middleware =
      maxInjectionTokens !== undefined
        ? createAceMiddleware({ ...config, maxInjectionTokens })
        : createAceMiddleware(config);

    // Track stores so L3 code can create the ACE tools provider with the same instances
    middlewareStores.set(middleware, { playbookStore });

    return middleware;
  },
};
