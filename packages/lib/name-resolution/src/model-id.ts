/**
 * Model identifier parsing — extracts provider prefix from model strings.
 *
 * Model strings follow the convention `provider:model-name` (e.g., "anthropic:claude-sonnet-4-5-20250929").
 * When no colon is present, the entire string is treated as the model name with an empty provider.
 */

/**
 * Parsed model identifier with provider and model name components.
 */
export interface ParsedModelId {
  /** Provider prefix (e.g., "anthropic", "openai"). Empty string if no prefix. */
  readonly provider: string;
  /** Model name after the provider prefix. */
  readonly modelName: string;
}

/**
 * Parse a model identifier string into provider and model name.
 *
 * @example
 * parseModelId("anthropic:claude-sonnet-4-5-20250929")
 * // → { provider: "anthropic", modelName: "claude-sonnet-4-5-20250929" }
 *
 * parseModelId("claude-sonnet-4-5-20250929")
 * // → { provider: "", modelName: "claude-sonnet-4-5-20250929" }
 *
 * parseModelId("openai:gpt-4:2024-05-13")
 * // → { provider: "openai", modelName: "gpt-4:2024-05-13" }
 */
export function parseModelId(model: string): ParsedModelId {
  if (model.length === 0) {
    return { provider: "", modelName: "" };
  }

  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) {
    return { provider: "", modelName: model };
  }

  return {
    provider: model.slice(0, colonIndex),
    modelName: model.slice(colonIndex + 1),
  };
}

/**
 * Extract just the provider prefix from a model string.
 * Returns empty string if no provider prefix is present.
 */
export function extractProvider(model: string): string {
  const colonIndex = model.indexOf(":");
  return colonIndex === -1 ? "" : model.slice(0, colonIndex);
}
