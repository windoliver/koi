/**
 * BrickDescriptor for @koi/engine-rlm.
 *
 * Enables manifest auto-resolution for the RLM engine adapter.
 */

import type { CompanionSkillDefinition, EngineAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";

const RLM_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-rlm-guide",
  description: "When to use engine: rlm",
  tags: ["engine", "rlm", "recursive", "unbounded-input"],
  content: `# Engine: rlm

## When to use
- Processing inputs that exceed the model's context window (100x+ larger)
- Analyzing large documents, codebases, or datasets via structured tool-calling
- Tasks requiring recursive sub-decomposition of large inputs
- When the model needs to programmatically examine and chunk input data

## Manifest example
\`\`\`yaml
engine:
  name: rlm
\`\`\`

## Required options
- None (model/tool handlers are injected by the CLI at runtime)

## Optional options
- \`maxIterations\`: REPL loop iteration limit (default: 30)
- \`chunkSize\`: Characters per chunk (default: 4000)
- \`maxInputBytes\`: Input size limit (default: 100MB)

## When NOT to use
- Small inputs that fit in the context window — use \`loop\` instead
- Interactive chat — RLM is designed for single-input processing
- Tasks that don't involve examining structured or large inputs
`,
};

/**
 * Descriptor for RLM engine adapter.
 *
 * Note: The RLM adapter requires a modelCall handler that cannot be
 * resolved from YAML alone. The factory throws — the CLI must inject
 * model/tool handlers after resolution.
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-rlm",
  aliases: ["rlm"],
  description: "Recursive Language Model engine — process unbounded inputs via virtualized REPL",
  tags: ["rlm", "recursive", "unbounded-input"],
  companionSkills: [RLM_COMPANION_SKILL],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "RLM engine"),
  factory(): EngineAdapter {
    throw new Error(
      "@koi/engine-rlm requires a modelCall handler. " +
        "Use createRlmAdapter(config) directly from the CLI.",
    );
  },
};
