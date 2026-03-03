/**
 * Model provider types for routing and capability matching.
 *
 * These thin types live in L0 so that L2 packages (model-router, engine adapters)
 * can share a common vocabulary for providers without importing each other.
 */

/**
 * Feature flags for model capability matching.
 *
 * Used by the model router to validate that a target model supports
 * the features required by a given request (e.g., vision, function calling).
 */
export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly functionCalling: boolean;
  readonly vision: boolean;
  readonly jsonMode: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Identifies a model provider for routing and capability matching.
 *
 * A provider represents a single LLM API endpoint (e.g., OpenAI, Anthropic).
 * The model router uses this to select and validate routing targets.
 */
export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

/**
 * A routing target: provider + model + weight.
 *
 * Used in routing configuration to define the ordered list of
 * provider/model combinations the router can dispatch to.
 */
export interface ModelTarget {
  readonly provider: string;
  readonly model: string;
  /** Routing weight between 0 and 1. Default: 1. */
  readonly weight?: number;
  /** Whether this target is active. Default: true. */
  readonly enabled?: boolean;
}
