/**
 * Memory source resolver — recalls from the agent's MemoryComponent.
 */

import type { Agent } from "@koi/core";
import { MEMORY } from "@koi/core";
import type { MemorySource, SourceResult } from "../types.js";

/** Resolves a memory source by querying the agent's MemoryComponent. */
export async function resolveMemorySource(
  source: MemorySource,
  agent: Agent,
): Promise<SourceResult> {
  const memory = agent.component(MEMORY);
  if (memory === undefined) {
    throw new Error("Agent has no MemoryComponent attached");
  }

  const results = await memory.recall(source.query);
  const content = results.map((r) => r.content).join("\n\n");

  return {
    label: source.label ?? `Memory: ${source.query}`,
    content,
    tokens: 0,
    source,
  };
}
