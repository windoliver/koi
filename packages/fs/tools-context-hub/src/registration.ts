/**
 * ToolRegistration for @koi/tools-context-hub — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given a ContextHubProviderConfig.
 * This bridges the gap between the generic ToolRegistration pattern (which uses
 * Agent + JsonObject) and the Context Hub provider's richer config (which includes
 * ContextHubExecutor and other non-serializable deps).
 *
 * Usage in a manifest:
 *   tools:
 *     - name: chub_search
 *       package: "@koi/tools-context-hub"
 */

import type { ToolRegistration } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { ContextHubExecutor } from "./context-hub-executor.js";
import { type ContextHubOperation, type ContextHubProviderConfig, OPERATIONS } from "./provider.js";
import { createChubGetTool } from "./tools/chub-get.js";
import { createChubSearchTool } from "./tools/chub-search.js";

type ToolFactory = (
  executor: ContextHubExecutor,
  prefix: string,
  policy: import("@koi/core").ToolPolicy,
) => import("@koi/core").Tool;

const TOOL_FACTORIES: Readonly<Record<ContextHubOperation, ToolFactory>> = {
  search: createChubSearchTool,
  get: createChubGetTool,
};

/**
 * Create a ToolRegistration for Context Hub tools.
 *
 * Call this with a ContextHubProviderConfig and export the result as `registration`.
 * The engine's auto-resolution will pick it up from the `package` field.
 */
export function createContextHubRegistration(config: ContextHubProviderConfig): ToolRegistration {
  const {
    executor,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "chub",
    operations = OPERATIONS,
  } = config;

  return {
    name: "context-hub",
    tools: operations.map((op) => ({
      name: `${prefix}_${op}`,
      create: () => TOOL_FACTORIES[op](executor, prefix, policy),
    })),
  };
}
