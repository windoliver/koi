/**
 * SkillRequiresExtension — KernelExtension that validates skill tool
 * dependencies at assembly time.
 *
 * Iterates all "skill:*" components, checks their `requires.tools` against
 * the set of available "tool:*" components, and emits console.warn for any
 * missing tool dependencies. Never blocks assembly (always returns ok: true).
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
 * Creates a KernelExtension that validates skill `requires.tools` against
 * assembled tool components. Warnings only — never blocks assembly.
 */
export function createSkillRequiresExtension(): KernelExtension {
  return {
    name: "koi:skill-requires",
    priority: EXTENSION_PRIORITY.CORE,

    validateAssembly(
      components: ReadonlyMap<string, unknown>,
      _manifest: AgentManifest,
    ): ValidationResult {
      // 1. Collect tool names from "tool:*" component keys
      const toolNames = new Set<string>();
      for (const key of components.keys()) {
        if (key.startsWith("tool:")) {
          toolNames.add(key.slice(5));
        }
      }

      // 2. Iterate "skill:*" components, check requires.tools
      for (const [key, value] of components) {
        if (!key.startsWith("skill:")) continue;
        if (!hasSkillShape(value)) continue;

        const requiredTools = value.requires?.tools;
        if (requiredTools === undefined || requiredTools.length === 0) continue;

        for (const requiredTool of requiredTools) {
          if (!toolNames.has(requiredTool)) {
            console.warn(
              `[koi] Skill "${value.name}" requires tool "${requiredTool}" which is not available. ` +
                `The skill may not function correctly.`,
            );
          }
        }
      }

      // Never block assembly — warnings only
      return { ok: true };
    },
  };
}
