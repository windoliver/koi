/**
 * createAceToolsProvider — builds a ComponentProvider that registers
 * the list_playbooks tool at agent attach() time.
 *
 * Follows the forge tools provider pattern: separate ComponentProvider
 * from the ACE middleware itself (middleware = system, provider = component factory).
 */

import type { Agent, ComponentProvider, SkillComponent } from "@koi/core";
import { skillToken } from "@koi/core";
import { SELF_FORGE_SKILL } from "./self-forge-skill.js";
import type { PlaybookStore, StructuredPlaybookStore } from "./stores.js";
import { createListPlaybooksTool } from "./tools/list-playbooks.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AceToolsProviderConfig {
  readonly playbookStore: PlaybookStore;
  readonly structuredPlaybookStore?: StructuredPlaybookStore | undefined;
  /**
   * Whether to attach the self-forge companion skill alongside the tool.
   * Set to `false` when forge tools (forge_skill, forge_tool, etc.) are not
   * available — the skill content references those tools and would mislead
   * the agent if they don't exist. Default: `true`.
   */
  readonly includeCompanionSkill?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Companion skill
// ---------------------------------------------------------------------------

// Re-exported as SkillComponent (content included) for direct attachment.
// The CompanionSkillDefinition on the descriptor handles ForgeStore registration;
// this attaches the skill content directly to the agent for immediate access.

const SELF_FORGE_SKILL_COMPONENT: SkillComponent = {
  name: SELF_FORGE_SKILL.name,
  description: SELF_FORGE_SKILL.description,
  content: SELF_FORGE_SKILL.content,
  // Spread conditionally to satisfy exactOptionalPropertyTypes —
  // CompanionSkillDefinition.tags is `readonly string[] | undefined`, but
  // SkillComponent.tags is `readonly string[]` (optional prop, not undefined).
  ...(SELF_FORGE_SKILL.tags !== undefined ? { tags: SELF_FORGE_SKILL.tags } : {}),
} as const satisfies SkillComponent;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a ComponentProvider that registers the list_playbooks tool
 * and the self-forge companion skill at attach() time.
 */
export function createAceToolsProvider(config: AceToolsProviderConfig): ComponentProvider {
  return {
    name: "ace-tools",
    priority: 60,
    attach: async (_agent: Agent) => {
      const components = new Map<string, unknown>();

      // list_playbooks tool
      components.set(
        "tool:list_playbooks",
        createListPlaybooksTool({
          playbookStore: config.playbookStore,
          structuredPlaybookStore: config.structuredPlaybookStore,
        }),
      );

      // Self-forge companion skill — only when forge tools are available.
      // The skill content references forge_skill, forge_tool, search_forge;
      // attaching it without those tools would give the agent bad instructions.
      if (config.includeCompanionSkill !== false) {
        components.set(skillToken("ace-self-forge") as string, SELF_FORGE_SKILL_COMPONENT);
      }

      return components;
    },
  };
}
