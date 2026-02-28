/**
 * BrickDescriptor for @koi/engine-claude.
 *
 * Enables manifest auto-resolution for the Claude Agent SDK engine.
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import type { CompanionSkillDefinition, EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";

const CLAUDE_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-claude-guide",
  description: "When to use engine: claude",
  tags: ["engine", "claude", "agent-sdk", "anthropic"],
  content: `# Engine: claude

## When to use
- Leveraging the Claude Agent SDK for agent orchestration
- Tasks requiring Claude's native tool use and multi-turn capabilities
- When you need Anthropic API features (extended thinking, prompt caching)
- Production deployments with Anthropic's managed infrastructure

## Manifest example
\`\`\`yaml
engine:
  name: claude
  options:
    model: "claude-sonnet-4-5-20250929"
\`\`\`

## Required options
- None (SDK bindings are injected by the CLI at runtime)
- \`ANTHROPIC_API_KEY\` environment variable must be set

## Optional options
- \`model\` (string): Claude model to use

## When NOT to use
- For non-Anthropic models (use \`pi\` with appropriate provider prefix)
- For external CLI tools (use \`acp\` or \`external\`)
- For simple tasks where the default loop suffices (use \`loop\`)
`,
};

function validateClaudeEngineOptions(input: unknown): Result<unknown, KoiError> {
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Claude engine options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: input ?? {} };
}

/**
 * Descriptor for Claude engine adapter.
 *
 * Note: The Claude adapter requires SDK function bindings that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject SDK
 * bindings after resolution. This descriptor registers the name/alias so
 * the resolver can validate and locate it.
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-claude",
  aliases: ["claude"],
  description: "Claude Agent SDK engine for Anthropic-native orchestration",
  tags: ["claude", "agent-sdk", "anthropic"],
  companionSkills: [CLAUDE_COMPANION_SKILL],
  optionsValidator: validateClaudeEngineOptions,
  factory(_options, _context: ResolutionContext): EngineAdapter {
    throw new Error(
      "@koi/engine-claude requires SDK function bindings. " +
        "Use createClaudeAdapter(config, sdk) directly from the CLI.",
    );
  },
};
