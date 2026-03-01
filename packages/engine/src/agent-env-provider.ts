/**
 * AgentEnvProvider — creates an inheritable key-value environment for child agents.
 *
 * Merges parent env with overrides. Enforces attenuation: child keys must be a
 * subset of parent keys (cannot introduce new keys not in parent).
 * Uses eager flatten (full copy) — no lazy lookups.
 */

import type { Agent, AgentEnv, ComponentProvider } from "@koi/core";
import { COMPONENT_PRIORITY, ENV } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentEnvProviderConfig {
  /** The parent agent whose env is inherited. */
  readonly parent: Agent;
  /** Key-value overrides. Set value to undefined to narrow (remove) a parent key. */
  readonly overrides?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Merge parent env values with overrides, enforcing attenuation.
 * Returns the flattened env values or throws on validation failure.
 *
 * Attenuation rule: overrides cannot introduce keys not present in parent.
 * Setting a key to undefined narrows (removes) it from the child env.
 */
export function mergeEnv(
  parentValues: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  // Validate: all override keys must exist in parent
  const parentKeys = new Set(Object.keys(parentValues));
  const invalidKeys: readonly string[] = Object.keys(overrides).filter((k) => !parentKeys.has(k));

  if (invalidKeys.length > 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Env attenuation violation: keys [${invalidKeys.join(", ")}] not present in parent env. ` +
        `Child env can only narrow parent env, not extend it.`,
      { retryable: false, context: { invalidKeys, parentKeys: [...parentKeys] } },
    );
  }

  // Build merged env: start with parent, apply overrides
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentValues)) {
    const override = overrides[key];
    if (override === undefined && key in overrides) {
      // Explicitly narrowed (removed) — skip this key
      continue;
    }
    result[key] = override ?? value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentEnvProvider(config: AgentEnvProviderConfig): ComponentProvider {
  return {
    name: "agent-env",
    priority: COMPONENT_PRIORITY.BUNDLED,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const parentEnv = config.parent.component(ENV);
      const parentValues = parentEnv?.values ?? {};

      const merged =
        config.overrides !== undefined
          ? mergeEnv(parentValues, config.overrides)
          : { ...parentValues };

      const childEnv: AgentEnv = {
        values: merged,
        parentEnv,
      };

      return new Map<string, unknown>([[ENV as string, childEnv]]);
    },
  };
}
