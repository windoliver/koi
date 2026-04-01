/**
 * Rich tool definition — the input type accepted by buildTool().
 *
 * Provides coarse capability flags (sandbox, network, filesystem) that
 * buildTool() maps into the L0 ToolPolicy structure.
 */

import type { JsonObject, ToolExecuteOptions, ToolOrigin } from "@koi/core";

/** Rich input type for buildTool(). Coarse flags get mapped to ToolPolicy. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly tags?: readonly string[];
  /** Required — callers must declare the trust tier explicitly. */
  readonly origin: ToolOrigin;
  /** When true or omitted, tool runs sandboxed. When false, unsandboxed. */
  readonly sandbox?: boolean;
  /** When true, tool is allowed network access. */
  readonly network?: boolean;
  /** Filesystem access paths. */
  readonly filesystem?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly execute: (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown>;
}

/**
 * Config for createToolComponentProvider().
 *
 * `priority` is required — callers must explicitly declare where their
 * provider sits in the assembly precedence hierarchy. Use COMPONENT_PRIORITY
 * constants from `@koi/core` (e.g. BUNDLED for system tools, AGENT_FORGED
 * for per-agent overrides).
 */
export interface ToolComponentProviderConfig {
  readonly name: string;
  readonly tools: readonly import("@koi/core").Tool[];
  readonly priority: number;
}
