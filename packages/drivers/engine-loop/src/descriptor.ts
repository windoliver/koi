/**
 * BrickDescriptor for @koi/engine-loop.
 *
 * Enables manifest auto-resolution for the pure TypeScript ReAct loop engine.
 */

import type { CompanionSkillDefinition, EngineAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";

const LOOP_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-loop-guide",
  description: "When to use engine: loop",
  tags: ["engine", "default", "react-loop", "typescript"],
  content: `# Engine: loop

## When to use
- Default engine for most agents — lightweight pure TypeScript ReAct loop
- Simple tool-calling tasks that don't need external processes
- When the CLI provides model/tool handlers directly
- Agents that use Koi's built-in model resolution and tool system

## Manifest example
\`\`\`yaml
engine:
  name: loop
\`\`\`

## Required options
- None (model/tool handlers are injected by the CLI at runtime)

## Optional options
- Engine options object may be empty or omitted entirely

## When NOT to use
- When you need to spawn an external coding agent (use \`acp\` or \`external\`)
- When you need direct low-level model API control (use \`pi\`)
- When you need Claude Agent SDK features (use \`claude\`)
`,
};

/**
 * Descriptor for loop engine adapter.
 *
 * Note: The loop adapter requires a modelCall handler that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject
 * model/tool handlers after resolution. This descriptor registers the
 * name/alias so the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-loop",
  aliases: ["loop"],
  description: "Default lightweight ReAct loop engine in pure TypeScript",
  tags: ["default", "react-loop", "typescript"],
  companionSkills: [LOOP_COMPANION_SKILL],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Loop engine"),
  factory(): EngineAdapter {
    throw new Error(
      "@koi/engine-loop requires a modelCall handler. " +
        "Use createLoopAdapter(config) directly from the CLI.",
    );
  },
};
