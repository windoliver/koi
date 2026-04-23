/**
 * Named toolset types — composable tool presets for agents, spawn, and channels.
 *
 * L0 contract: types only. Resolution logic lives in @koi/toolsets (L2).
 */

/**
 * A named group of tool names that can compose other toolsets by reference.
 *
 * `tools` contains literal tool names. The reserved value `"*"` signals "all tools
 * (no filter)"; the resolver converts it to `{ mode: "all" }` and never surfaces it
 * in an allowlist — callers always receive the `ToolsetResolution` tagged union.
 * `includes` contains names of other toolsets to recursively compose.
 */
export interface ToolsetDefinition {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  /** Names of other toolsets to include recursively. */
  readonly includes: readonly string[];
}

/** Immutable map from toolset name to its definition. */
export type ToolsetRegistry = ReadonlyMap<string, ToolsetDefinition>;

/**
 * Tagged result of toolset resolution. Callers must handle both modes explicitly —
 * they cannot be mixed into a single allowlist array.
 *
 * - `"all"` — no filter; the agent receives every available tool.
 * - `"allowlist"` — the agent receives only the listed tools.
 */
export type ToolsetResolution =
  | { readonly mode: "all" }
  | { readonly mode: "allowlist"; readonly tools: readonly string[] };
