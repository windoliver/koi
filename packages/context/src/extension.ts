/**
 * KernelExtension for auto-wiring manifest.context into the middleware chain.
 *
 * Solves the chicken-and-egg problem: createContextHydrator needs an Agent,
 * but Agent is created inside createKoi. The extension's guards slot receives
 * the agent via GuardContext after assembly, then creates the hydrator.
 */

import type { GuardContext, KernelExtension, KoiMiddleware } from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import { validateContextConfig } from "./config.js";
import { createContextHydrator } from "./hydrator.js";

/**
 * Creates a KernelExtension that wires manifest.context into the middleware chain.
 *
 * Usage in CLI start.ts / serve.ts:
 * ```
 * const contextExt = createContextExtension(manifest.context);
 * const runtime = await createKoi({ manifest, adapter, extensions: [contextExt] });
 * ```
 *
 * @param rawConfig - The raw `manifest.context` value (unknown from ManifestExtensions)
 * @returns KernelExtension, or undefined if no context config is present
 */
export function createContextExtension(rawConfig: unknown): KernelExtension | undefined {
  if (rawConfig === undefined || rawConfig === null) {
    return undefined;
  }

  const validated = validateContextConfig(rawConfig);
  if (!validated.ok) {
    throw new Error(`Invalid context configuration in manifest: ${validated.error.message}`);
  }

  const config = validated.value;

  return {
    name: "koi:context-hydrator",
    priority: EXTENSION_PRIORITY.USER,

    guards(ctx: GuardContext): readonly KoiMiddleware[] {
      if (ctx.agent === undefined) {
        throw new Error(
          "Context hydrator extension requires agent in GuardContext. " +
            "Ensure createKoi passes agent to guard context.",
        );
      }

      const hydrator = createContextHydrator({
        config,
        agent: ctx.agent,
      });

      return [hydrator];
    },
  };
}
