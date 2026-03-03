/**
 * BrickDescriptor for @koi/engine-pi.
 *
 * Enables manifest auto-resolution for the Pi agent engine.
 */

import type { CompanionSkillDefinition, EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createPiAdapter } from "./adapter.js";
import type { PiAdapterConfig } from "./types.js";

const PI_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-pi-guide",
  description: "When to use engine: pi",
  tags: ["engine", "llm", "streaming", "thinking", "tool-use"],
  content: `# Engine: pi

## When to use
- Multi-turn LLM reasoning with tool calls
- Direct model access with streaming and thinking support
- Tasks requiring iterative model ↔ tool interaction loops
- When you need fine-grained control over model parameters

## Manifest example
\`\`\`yaml
engine:
  name: pi
  options:
    model: "anthropic:claude-sonnet-4-5-20250929"
    systemPrompt: "You are a helpful assistant."
\`\`\`

## Required options
- \`model\` (string): Model identifier in "provider:model" format

## Optional options
- \`systemPrompt\` (string): System prompt for the model

## When NOT to use
- When you need an external CLI agent (use \`acp\` or \`external\` instead)
- For simple one-shot tasks where the default loop engine suffices
`,
};

function validatePiEngineOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateOptionalDescriptorOptions(input, "Pi engine");
  if (!base.ok) return base;
  const opts = base.value;

  if (typeof opts.model !== "string" || opts.model === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pi.model is required (e.g., 'anthropic:claude-sonnet-4-5-20250929')",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for Pi engine adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-pi",
  aliases: ["pi"],
  description: "Multi-turn LLM reasoning engine with pi-agent-core",
  tags: ["llm", "streaming", "thinking", "tool-use"],
  companionSkills: [PI_COMPANION_SKILL],
  optionsValidator: validatePiEngineOptions,
  factory(options): EngineAdapter {
    const model = options.model;
    if (typeof model !== "string") {
      throw new Error("pi.model is required");
    }

    const config: PiAdapterConfig = {
      model,
      ...(typeof options.systemPrompt === "string" ? { systemPrompt: options.systemPrompt } : {}),
    };

    return createPiAdapter(config);
  },
};
