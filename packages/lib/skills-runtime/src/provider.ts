/**
 * createSkillProvider — ComponentProvider bridge from SkillsRuntime to the agent ECS.
 *
 * This is the L3 hook: it takes a SkillsRuntime, discovers/loads skills,
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

export interface SkillProviderConfig {
  /**
   * When true: call discover() only, attaching SkillComponents with empty
   * content. The middleware injects an <available_skills> block from
   * descriptions; full bodies load on demand via the Skill tool.
   *
   * When false (default): call loadAll() to eagerly load all bodies and
   * inject them into systemPrompt at every model call.
   */
  readonly progressive?: boolean;
}

/**
 * Creates a ComponentProvider that bridges a SkillsRuntime to the agent ECS.
 *
 * Eager mode (default, progressive: false):
 *   Calls runtime.loadAll(), converts each SkillDefinition → SkillComponent
 *   with full body in content.
 *
 * Progressive mode (progressive: true):
 *   Calls runtime.loadAll() for full failure visibility (blocked/VALIDATION skills
 *   appear in AttachResult.skipped), then attaches successful skills with content: ""
 *   and runtimeBacked: true. Bodies are loaded on demand via the Skill tool.
 *   The middleware injects an <available_skills> XML summary block per model call.
 *
 * Compatible with Nexus in the future: swap the runtime implementation,
 * keep the same provider.
 */
export function createSkillProvider(
  runtime: SkillsRuntime,
  config?: SkillProviderConfig,
): ComponentProvider {
  const progressive = config?.progressive ?? false;
  return {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> =>
      progressive ? attachProgressive(runtime) : attachEager(runtime),
  };
}

// ---------------------------------------------------------------------------
// Attach strategies
// ---------------------------------------------------------------------------

async function attachEager(runtime: SkillsRuntime): Promise<AttachResult> {
  const allResult = await runtime.loadAll();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!allResult.ok) {
    skipped.push({ name: "__discover__", reason: allResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, result] of allResult.value) {
    if (!result.ok) {
      skipped.push({ name, reason: result.error.message });
      continue;
    }
    components.set(skillToken(name), skillDefinitionToComponent(result.value));
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
}

async function attachProgressive(runtime: SkillsRuntime): Promise<AttachResult> {
  // Call loadAll() for full blocked/VALIDATION visibility (same skipped contract as eager).
  // Bodies are loaded but discarded — successful skills are attached with content: "" so
  // the middleware injects a compact <available_skills> block instead of full bodies.
  const allResult = await runtime.loadAll();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!allResult.ok) {
    skipped.push({ name: "__discover__", reason: allResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, result] of allResult.value) {
    if (!result.ok) {
      skipped.push({ name, reason: result.error.message });
      continue;
    }
    components.set(skillToken(name), skillDefinitionToProgressiveComponent(result.value));
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
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
    ...(skill.allowedTools !== undefined ? { tags: skill.allowedTools } : {}),
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
    ...(skill.executionMode !== undefined ? { executionMode: skill.executionMode } : {}),
  };
}

/**
 * Converts a loaded SkillDefinition to a progressive SkillComponent.
 * Body is discarded (content: ""); runtimeBacked: true marks this as a
 * runtime-backed progressive skill so the middleware knows it belongs in
 * <available_skills> rather than being silently excluded like MCP stubs.
 */
function skillDefinitionToProgressiveComponent(skill: SkillDefinition): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: "",
    runtimeBacked: true,
    ...(skill.allowedTools !== undefined ? { tags: skill.allowedTools } : {}),
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
    ...(skill.executionMode !== undefined ? { executionMode: skill.executionMode } : {}),
  };
}
