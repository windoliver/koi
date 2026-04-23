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
   * When true: validate all skills at attach time via loadAll() but attach each
   * successful skill with content: "" and runtimeBacked: true. The middleware
   * injects a compact <available_skills> XML block per model call instead of full
   * bodies, reducing per-call prompt tokens. Blocked/VALIDATION skills are still
   * reported in AttachResult.skipped for operator visibility.
   *
   * Trade-off vs. eager mode (progressive: false):
   * - Both modes call loadAll() at startup (same validation and startup cost)
   * - Progressive: ~100 tokens injected per model call (XML metadata only)
   * - Eager: body text injected at every model call (can be thousands of tokens)
   *
   * When false (default): call loadAll() and inject full bodies into systemPrompt
   * at every model call.
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
 *   Calls runtime.loadAll() for full blocked/VALIDATION visibility, then attaches
 *   each successful skill with content: "" and runtimeBacked: true. Bodies are
 *   discarded at attach time; the Skill tool re-loads a body on demand when the
 *   model invokes a skill. The middleware injects an <available_skills> XML block.
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
  // loadAll() gives full blocked/VALIDATION visibility for the skipped list —
  // the same parity as eager mode.
  //
  // After collecting validation results, evict each successful skill's body from
  // the LRU cache via invalidate(name). This ensures Skill tool invocations always
  // load fresh content from disk rather than the body snapshot taken at attach time.
  // Without eviction, edits to SKILL.md after session start would be invisible to
  // the agent for the rest of the session.
  //
  // Do NOT call invalidate() with no args: full invalidation clears externalSkills
  // and discovery state, which would break Skill tool load() calls for externally-
  // registered skills.
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
    // MCP (source: "mcp") skills have no SKILL.md body — body is their empty
    // description. Marking them runtimeBacked would advertise them in the
    // <available_skills> XML block even though Skill() would return an empty
    // body. Use the eager helper instead so they are filtered by content === ""
    // in injectSkills, matching eager-mode behavior.
    if (result.value.source === "mcp") {
      components.set(skillToken(name), skillDefinitionToComponent(result.value));
    } else {
      components.set(skillToken(name), skillDefinitionToProgressiveComponent(result.value));
      runtime.invalidate(name);
    }
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
