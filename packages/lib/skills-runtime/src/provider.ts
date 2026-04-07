/**
 * createSkillProvider — ComponentProvider bridge from SkillsRuntime to the agent ECS.
 *
 * This is the L3 hook: it takes a SkillsRuntime, loads all discovered skills,
 * and attaches them to an Agent as SkillComponent instances under skillToken(name) keys.
 * The engine middleware then surfaces them to the model via describeCapabilities().
 *
 * Skipped skills (NOT_FOUND, VALIDATION, PERMISSION) are reported as SkippedComponent
 * entries rather than throwing — partial success is the right behavior.
 */

import type {
  Agent,
  AttachResult,
  BrickRequires,
  ComponentProvider,
  SkillComponent,
} from "@koi/core";
import { COMPONENT_PRIORITY, skillToken } from "@koi/core";
import type { SkillDefinition, SkillsRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that bridges a SkillsRuntime to the agent ECS.
 *
 * At attach time:
 * 1. Calls runtime.loadAll() (which auto-discovers + loads all skills)
 * 2. Converts each SkillDefinition → SkillComponent
 * 3. Attaches each under skillToken(name) so engine middleware can surface them
 * 4. Reports failures as SkippedComponent entries (PERMISSION blocks included)
 *
 * Compatible with Nexus in the future: swap the runtime implementation,
 * keep the same provider.
 */
export function createSkillProvider(runtime: SkillsRuntime): ComponentProvider {
  return {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> => {
      const allResult = await runtime.loadAll();

      const components = new Map<string, unknown>();
      const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

      // Handle outer discovery failure (Issue 3A: loadAll() now returns Result)
      if (!allResult.ok) {
        skipped.push({ name: "__discover__", reason: allResult.error.message });
        return {
          components: components as ReadonlyMap<string, unknown>,
          skipped,
        };
      }

      for (const [name, result] of allResult.value) {
        if (!result.ok) {
          skipped.push({ name, reason: result.error.message });
          continue;
        }
        const skill = result.value;
        const component: SkillComponent = {
          name: skill.name,
          description: skill.description,
          content: skill.body,
          ...(skill.allowedTools !== undefined ? { tags: skill.allowedTools } : {}),
          ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
        };
        components.set(skillToken(name), component);
      }

      return {
        components: components as ReadonlyMap<string, unknown>,
        skipped,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a SkillDefinition to a SkillComponent (for consumers that already
 * have a loaded definition and want to attach it directly).
 */
export function skillDefinitionToComponent(skill: SkillDefinition): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.body,
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
  };
}
