/**
 * createToolComponentProvider() — Wraps a tool pool into a ComponentProvider.
 *
 * Each tool is attached under its `toolToken(name)` key, enabling
 * `agent.component(toolToken("my-tool"))` lookups.
 *
 * `priority` is required so callers must explicitly declare their tier
 * in agent assembly. Cross-provider tool precedence is an L1 concern —
 * this package only manages intra-pool dedup via `assembleToolPool()`.
 */

import type { Agent, AttachResult, ComponentProvider, SkippedComponent, Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import { deepFreeze } from "./deep-freeze.js";
import { assembleToolPool } from "./tool-pool.js";
import type { ToolComponentProviderConfig } from "./types.js";

/** Clone a tool's data fields (descriptor + policy). execute is kept by reference. */
function cloneTool(tool: Tool): Tool {
  return {
    descriptor: {
      ...tool.descriptor,
      inputSchema: structuredClone(tool.descriptor.inputSchema),
      ...(tool.descriptor.tags !== undefined ? { tags: [...tool.descriptor.tags] } : {}),
    },
    origin: tool.origin,
    policy: {
      sandbox: tool.policy.sandbox,
      capabilities: structuredClone(tool.policy.capabilities),
    },
    execute: tool.execute,
  };
}

/**
 * Create a ComponentProvider that attaches tools under `toolToken(name)` keys.
 *
 * `priority` is required — use `COMPONENT_PRIORITY` constants from `@koi/core`
 * to declare where this provider sits in assembly precedence (e.g. `BUNDLED`
 * for system tools, `AGENT_FORGED` for per-agent overrides).
 *
 * Tools are deduplicated and sorted via `assembleToolPool()` at construction.
 * Each tool is cloned and deep-frozen so caller-owned objects are not mutated.
 */
export function createToolComponentProvider(
  config: ToolComponentProviderConfig,
): ComponentProvider {
  const { name, tools, priority } = config;
  const pool = assembleToolPool(tools);
  // Clone each tool so we don't mutate caller-owned objects, then deep-freeze.
  // Malformed tools are tracked in skipped for observability.
  const entries: (readonly [string, unknown])[] = [];
  const skipped: SkippedComponent[] = [];
  for (const tool of pool) {
    try {
      const owned = cloneTool(tool);
      deepFreeze(owned);
      entries.push([toolToken(owned.descriptor.name) as string, owned] as const);
    } catch (e: unknown) {
      skipped.push({
        name: tool.descriptor?.name ?? "unknown",
        reason: e instanceof Error ? e.message : "Failed to clone/freeze tool",
      });
    }
  }

  return {
    name,
    priority,

    async attach(_agent: Agent): Promise<AttachResult> {
      return { components: new Map(entries), skipped: [...skipped] };
    },
  };
}
