/**
 * BrickRequiresExtension — KernelExtension that validates brick
 * dependencies (tools + agents) at assembly time.
 *
 * Iterates all "skill:*" components, checks their `requires.tools` and
 * `requires.agents` against the set of available "tool:*" and "agent:*"
 * components, and emits console.warn for any missing dependencies.
 * Never blocks assembly (always returns ok: true).
 */

import type { AgentManifest, BrickRequires, KernelExtension, ValidationResult } from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";

/** Duck-type check: value has the shape we need (name + optional requires). */
function hasSkillShape(
  value: unknown,
): value is { readonly name: string; readonly requires?: BrickRequires } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

/**
 * Creates a KernelExtension that validates skill `requires.tools` and
 * `requires.agents` against assembled components. Warnings only — never blocks assembly.
 */
export function createBrickRequiresExtension(): KernelExtension {
  return {
    name: "koi:brick-requires",
    priority: EXTENSION_PRIORITY.CORE,

    validateAssembly(
      components: ReadonlyMap<string, unknown>,
      _manifest: AgentManifest,
    ): ValidationResult {
      // 1. Collect tool + agent names from component keys (single pass)
      const toolNames = new Set<string>();
      const agentNames = new Set<string>();
      for (const key of components.keys()) {
        if (key.startsWith("tool:")) {
          toolNames.add(key.slice(5));
        } else if (key.startsWith("agent:")) {
          agentNames.add(key.slice(6));
        }
      }

      // 2. Iterate "skill:*" components, check requires.tools and requires.agents
      for (const [key, value] of components) {
        if (!key.startsWith("skill:")) continue;
        if (!hasSkillShape(value)) continue;

        const requires = value.requires;
        if (requires === undefined) continue;

        const requiredTools = requires.tools;
        if (requiredTools !== undefined && requiredTools.length > 0) {
          for (const requiredTool of requiredTools) {
            if (!toolNames.has(requiredTool)) {
              console.warn(
                `[koi] Skill "${value.name}" requires tool "${requiredTool}" which is not available. ` +
                  `The skill may not function correctly.`,
              );
            }
          }
        }

        const requiredAgents = requires.agents;
        if (requiredAgents !== undefined && requiredAgents.length > 0) {
          for (const requiredAgent of requiredAgents) {
            if (!agentNames.has(requiredAgent)) {
              console.warn(
                `[koi] Skill "${value.name}" requires agent "${requiredAgent}" which is not available. ` +
                  `The skill may not function correctly.`,
              );
            }
          }
        }
      }

      // Never block assembly — warnings only
      return { ok: true };
    },
  };
}
