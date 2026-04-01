/**
 * McpComponentProvider — attaches MCP tools as components to agents.
 *
 * Delegates to McpResolver for tool discovery and loading. Surfaces
 * failed servers as SkippedComponent entries in AttachResult.
 */

import type { Agent, AttachResult, ComponentProvider, Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import type { McpResolver } from "./resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpComponentProviderOptions {
  readonly resolver: McpResolver;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that attaches MCP tools to agents.
 *
 * Tools are discovered lazily on first attach() via the resolver.
 * Failed servers appear in AttachResult.skipped.
 */
export function createMcpComponentProvider(
  options: McpComponentProviderOptions,
): ComponentProvider {
  const { resolver } = options;

  const attach = async (_agent: Agent): Promise<AttachResult> => {
    const descriptors = await resolver.discover();

    const components = new Map<string, unknown>();
    const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

    // Load each discovered tool into a full Tool component
    const loadResults = await Promise.allSettled(
      descriptors.map(async (descriptor) => {
        const result = await resolver.load(descriptor.name);
        return { descriptor, result };
      }),
    );

    for (const settled of loadResults) {
      if (settled.status === "rejected") {
        skipped.push({
          name: "unknown",
          reason: `Unexpected error loading tool: ${String(settled.reason)}`,
        });
        continue;
      }

      const { descriptor, result } = settled.value;
      if (!result.ok) {
        skipped.push({
          name: descriptor.name,
          reason: result.error.message,
        });
        continue;
      }

      components.set(toolToken(descriptor.name) as string, result.value as Tool);
    }

    // Surface resolver-level server failures as skipped components
    for (const failure of resolver.failures) {
      skipped.push({
        name: `mcp-server:${failure.serverName}`,
        reason: failure.error.message,
      });
    }

    return { components, skipped };
  };

  return {
    name: "mcp",
    attach,
  };
}
