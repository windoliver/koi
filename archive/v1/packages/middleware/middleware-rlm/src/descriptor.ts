/**
 * BrickDescriptor for @koi/middleware-rlm.
 *
 * Enables manifest auto-resolution for the RLM middleware.
 */

import type { CompanionSkillDefinition, KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createRlmMiddleware } from "./rlm.js";

function validateRlmDescriptorOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateOptionalDescriptorOptions(input, "RLM middleware");
  if (!base.ok) return base;
  const opts = base.value;

  if (
    opts.maxIterations !== undefined &&
    (typeof opts.maxIterations !== "number" || opts.maxIterations <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "rlm.maxIterations must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.chunkSize !== undefined && (typeof opts.chunkSize !== "number" || opts.chunkSize <= 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "rlm.chunkSize must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.contextWindowTokens !== undefined &&
    (typeof opts.contextWindowTokens !== "number" || opts.contextWindowTokens <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "rlm.contextWindowTokens must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.maxInputBytes !== undefined &&
    (typeof opts.maxInputBytes !== "number" || opts.maxInputBytes <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "rlm.maxInputBytes must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

const RLM_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "middleware-rlm-guide",
  description: "When to use middleware: rlm",
  tags: ["middleware", "rlm", "recursive", "unbounded-input"],
  content: `# Middleware: rlm

## When to use
- Processing inputs that exceed the model's context window (100x+ larger)
- Analyzing large documents, codebases, or datasets via structured tool-calling
- Tasks requiring recursive sub-decomposition of large inputs
- When the model needs to programmatically examine and chunk input data

## Manifest example
\`\`\`yaml
middleware:
  - name: rlm
\`\`\`

## Optional options
- \`maxIterations\`: REPL loop iteration limit (default: 30)
- \`chunkSize\`: Characters per chunk (default: 4000)
- \`maxInputBytes\`: Input size limit (default: 100MB)
- \`contextWindowTokens\`: Context window budget (default: 100,000)

## When NOT to use
- Small inputs that fit in the context window
- Interactive chat — RLM is designed for single-input processing
- Tasks that don't involve examining structured or large inputs
`,
};

/**
 * Descriptor for RLM middleware.
 *
 * Creates an RLM middleware from validated manifest options.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-rlm",
  aliases: ["rlm"],
  description:
    "Recursive Language Model middleware — process unbounded inputs via virtualized REPL",
  tags: ["rlm", "recursive", "unbounded-input"],
  companionSkills: [RLM_COMPANION_SKILL],
  optionsValidator: validateRlmDescriptorOptions,
  factory(options): KoiMiddleware {
    return createRlmMiddleware({
      ...(typeof options.maxIterations === "number"
        ? { maxIterations: options.maxIterations }
        : {}),
      ...(typeof options.chunkSize === "number" ? { chunkSize: options.chunkSize } : {}),
      ...(typeof options.contextWindowTokens === "number"
        ? { contextWindowTokens: options.contextWindowTokens }
        : {}),
      ...(typeof options.maxInputBytes === "number"
        ? { maxInputBytes: options.maxInputBytes }
        : {}),
      ...(typeof options.maxConcurrency === "number"
        ? { maxConcurrency: options.maxConcurrency }
        : {}),
    });
  },
};
