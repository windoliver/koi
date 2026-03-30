/**
 * ToolRegistration for @koi/tools-web — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given a WebProviderConfig.
 * This bridges the gap between the generic ToolRegistration pattern (which uses
 * Agent + JsonObject) and the web provider's richer config (which includes
 * WebExecutor and other non-serializable deps).
 *
 * Usage in a manifest:
 *   tools:
 *     - name: web_fetch
 *       package: "@koi/tools-web"
 */

import type { ToolRegistration } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { OPERATIONS, type WebOperation } from "./constants.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import type { WebProviderConfig } from "./web-component-provider.js";
import type { WebExecutor } from "./web-executor.js";

type ToolFactory = (
  executor: WebExecutor,
  prefix: string,
  policy: import("@koi/core").ToolPolicy,
) => import("@koi/core").Tool;

const TOOL_FACTORIES: Readonly<Record<WebOperation, ToolFactory>> = {
  fetch: createWebFetchTool,
  search: createWebSearchTool,
};

/**
 * Create a ToolRegistration for web tools.
 *
 * Call this with a WebProviderConfig and export the result as `registration`.
 * The engine's auto-resolution will pick it up from the `package` field.
 */
export function createWebRegistration(config: WebProviderConfig): ToolRegistration {
  const {
    executor,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "web",
    operations = OPERATIONS,
  } = config;

  return {
    name: "web",
    tools: operations.map((op) => ({
      name: `${prefix}_${op}`,
      create: () => TOOL_FACTORIES[op](executor, prefix, policy),
    })),
  };
}
