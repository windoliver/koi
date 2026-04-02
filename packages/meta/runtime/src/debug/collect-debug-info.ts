import type { ChannelAdapter, EngineAdapter, KoiMiddleware } from "@koi/core";
import type { MiddlewareDebugEntry, RuntimeDebugInfo } from "../types.js";

/**
 * Collects debug introspection data from the assembled runtime.
 * Returns a snapshot of what's wired vs stubbed: middleware chain,
 * adapter identity, and channel capabilities.
 *
 * @param stubInstances - The set of middleware instances that are stubs
 *   (compared by reference identity, not by name).
 */
export function collectDebugInfo(
  middleware: readonly KoiMiddleware[],
  adapter: EngineAdapter,
  channel: ChannelAdapter,
  stubInstances: ReadonlySet<KoiMiddleware>,
): RuntimeDebugInfo {
  const middlewareEntries: readonly MiddlewareDebugEntry[] = middleware.map((mw) => ({
    name: mw.name,
    phase: mw.phase ?? "resolve",
    priority: mw.priority ?? 500,
    enabled: true,
    stubbed: stubInstances.has(mw),
  }));

  return {
    middleware: middlewareEntries,
    tools: [], // Populated when @koi/tools-builtin lands
    adapter: {
      name: adapter.engineId,
      stubbed: adapter.engineId === "stub" || adapter.engineId === "replay",
    },
    channel: {
      name: channel.name,
      capabilities: channel.capabilities,
    },
  };
}

/**
 * Formats debug info as a human-readable text block for the test CLI.
 */
export function formatDebugInfo(info: RuntimeDebugInfo): string {
  const lines: string[] = ["=== Runtime Stack ==="];

  lines.push(`\nAdapter: ${info.adapter.name}${info.adapter.stubbed ? " (stub)" : ""}`);
  lines.push(`Channel: ${info.channel.name}`);

  if (info.middleware.length > 0) {
    lines.push("\nMiddleware chain:");
    for (const mw of info.middleware) {
      const tag = mw.stubbed ? " [stub]" : "";
      lines.push(`  ${mw.phase}/${mw.priority} ${mw.name}${tag}`);
    }
  } else {
    lines.push("\nMiddleware chain: (empty)");
  }

  if (info.tools.length > 0) {
    lines.push(`\nTools: ${info.tools.map((t) => t.name).join(", ")}`);
  }

  return lines.join("\n");
}
