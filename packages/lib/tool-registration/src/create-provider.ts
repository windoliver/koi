/**
 * createProviderFromRegistration — builds a ComponentProvider from a ToolRegistration.
 *
 * Handles availability gating (fail-closed), skip reporting, and per-tool
 * construction. Eliminates the repetitive ComponentProvider boilerplate
 * that every L2 tool package previously wrote by hand.
 */

import type {
  Agent,
  AttachResult,
  ComponentProvider,
  EnvReader,
  JsonObject,
  SkippedComponent,
  ToolRegistration,
} from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";

/** Default availability check timeout in milliseconds. */
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

/**
 * Create a ComponentProvider from a ToolRegistration descriptor.
 *
 * The provider runs the registration's availability check (if present) and
 * then creates each tool via its factory. If the availability check fails
 * or throws, all tools are reported as skipped (fail-closed).
 *
 * @param registration - The self-describing tool registration from an L2 package.
 * @param options - Optional per-tool configuration passed to each ToolFactory.create().
 * @param env - Environment snapshot for availability checks. Defaults to process.env.
 * @param timeoutMs - Availability check timeout. Defaults to 5000ms.
 */
export function createProviderFromRegistration(
  registration: ToolRegistration,
  options?: JsonObject,
  env?: EnvReader,
  timeoutMs?: number,
): ComponentProvider {
  const effectiveEnv: EnvReader = env ?? (process.env as EnvReader);
  const effectiveTimeout = timeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;

  return {
    name: registration.name,
    priority: COMPONENT_PRIORITY.BUNDLED,

    attach: async (agent: Agent): Promise<AttachResult> => {
      // --- Availability gate (fail-closed) ---
      if (registration.checkAvailability !== undefined) {
        const available = await checkWithTimeout(
          registration.checkAvailability,
          effectiveEnv,
          effectiveTimeout,
        );
        if (!available) {
          const skipped: readonly SkippedComponent[] = registration.tools.map((tf) => ({
            name: tf.name,
            reason: `Availability check failed for provider "${registration.name}"`,
          }));
          return { components: new Map<string, unknown>(), skipped };
        }
      }

      // --- Create tools ---
      const components = new Map<string, unknown>();
      const skipped: SkippedComponent[] = [];

      for (const factory of registration.tools) {
        try {
          const tool = await factory.create(agent, options);
          components.set(toolToken(factory.name) as string, tool);
        } catch (err: unknown) {
          skipped.push({
            name: factory.name,
            reason: `Tool creation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      return { components, skipped };
    },
  };
}

/**
 * Run an availability check with a timeout. Fail-closed on error or timeout.
 */
async function checkWithTimeout(
  check: (env: EnvReader) => boolean | Promise<boolean>,
  env: EnvReader,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const result = check(env);
    // Fast path: sync check returns boolean directly
    if (typeof result === "boolean") return result;
    // Async check: race against timeout
    return await Promise.race([
      result,
      new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("Availability check timed out")), timeoutMs);
      }),
    ]);
  } catch (_err: unknown) {
    // Fail-closed: any error means unavailable
    return false;
  }
}
