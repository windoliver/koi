/**
 * McpComponentProvider — attaches MCP tools as components to agents.
 *
 * Delegates to McpResolver for tool discovery and loading. Surfaces
 * failed servers as SkippedComponent entries in AttachResult.
 */

import type { Agent, AttachResult, ComponentProvider, Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import type { McpResolver, McpServerFailure } from "./resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Factory that creates auth pseudo-tools for servers requiring OAuth.
 * Injected by the host (CLI) which owns the OAuth runtime.
 * Called once per `AUTH_REQUIRED` failure during `attach()`.
 */
export type AuthToolFactory = (failure: McpServerFailure) => readonly Tool[];

export interface McpComponentProviderOptions {
  readonly resolver: McpResolver;
  /**
   * Optional factory for creating authentication pseudo-tools.
   * When provided and a server failure has code `AUTH_REQUIRED`,
   * the factory is called to produce Tool objects instead of
   * recording the server as a skipped component.
   */
  readonly createAuthTools?: AuthToolFactory | undefined;
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
  const { resolver, createAuthTools } = options;

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

    // Surface resolver-level server failures as skipped components,
    // or as auth pseudo-tools when a factory is provided and the
    // failure is an auth challenge.
    for (const failure of resolver.failures) {
      if (failure.error.code === "AUTH_REQUIRED" && createAuthTools !== undefined) {
        const authTools = createAuthTools(failure);
        if (authTools.length > 0) {
          for (const tool of authTools) {
            components.set(toolToken(tool.descriptor.name) as string, tool);
          }
        } else {
          // Factory returned nothing (e.g. non-OAuth server with AUTH_REQUIRED) —
          // fall through to skipped so the failure signal isn't lost.
          skipped.push({
            name: `mcp-server:${failure.serverName}`,
            reason: failure.error.message,
          });
        }
      } else {
        skipped.push({
          name: `mcp-server:${failure.serverName}`,
          reason: failure.error.message,
        });
      }
    }

    return { components, skipped };
  };

  return {
    name: "mcp",
    attach,
  };
}
