/**
 * Named toolset types — composable tool presets for agents, spawn, and channels.
 *
 * L0 contract: types only. Resolution logic lives in @koi/toolsets (L2).
 */

/**
 * A named group of tool names that can compose other toolsets by reference.
 *
 * `tools` contains literal tool names (or the wildcard `"*"` meaning all tools).
 * `includes` contains names of other toolsets to recursively compose.
 */
export interface ToolsetDefinition {
  readonly name: string;
  readonly description: string;
  /** Literal tool names. Use `"*"` as a sentinel for "all tools (no filter)". */
  readonly tools: readonly string[];
  /** Names of other toolsets to include recursively. */
  readonly includes: readonly string[];
}

/** Immutable map from toolset name to its definition. */
export type ToolsetRegistry = ReadonlyMap<string, ToolsetDefinition>;
