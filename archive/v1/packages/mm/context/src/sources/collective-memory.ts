/**
 * Collective memory source resolver — loads and formats learnings from brick artifacts.
 *
 * Two usage modes:
 * 1. Built-in: resolves ForgeStore from agent.component(token("forge-store"))
 * 2. Factory: createCollectiveMemoryResolver(forgeStore) returns a SourceResolver
 */

import type { Agent, BrickId, CollectiveMemory, ForgeStore } from "@koi/core";
import { COLLECTIVE_MEMORY_DEFAULTS, DEFAULT_COLLECTIVE_MEMORY, token } from "@koi/core";
import { selectEntriesWithinBudget } from "@koi/validation";
import type { CollectiveMemoryContextSource, SourceResolver, SourceResult } from "../types.js";

/** Well-known ECS token for ForgeStore — injected by L1 during assembly. */
const FORGE_STORE = token<ForgeStore>("forge-store");

const DEFAULT_BUDGET = COLLECTIVE_MEMORY_DEFAULTS.injectionBudget;
const CHARS_PER_TOKEN = 4;

/**
 * Formats collective memory entries into a human-readable markdown string.
 */
function formatEntries(memory: CollectiveMemory, budget: number): string {
  const selected = selectEntriesWithinBudget(memory.entries, budget, CHARS_PER_TOKEN);
  if (selected.length === 0) return "";

  const lines = selected.map((e) => `- [${e.category}] ${e.content}`);
  return `## Collective Memory\n\n${lines.join("\n")}`;
}

/**
 * Resolves a collective_memory source using the agent's ForgeStore component.
 *
 * Used as a built-in resolver in the context hydrator.
 * Requires the agent to have a ForgeStore component attached.
 */
export async function resolveCollectiveMemorySource(
  source: CollectiveMemoryContextSource,
  agent: Agent,
): Promise<SourceResult> {
  const store = agent.component(FORGE_STORE);
  if (store === undefined) {
    throw new Error(
      "Agent has no ForgeStore component attached — cannot resolve collective memory",
    );
  }

  const brickIdStr = source.brickId ?? agent.manifest.name;
  const loadResult = await store.load(brickIdStr as BrickId);

  if (!loadResult.ok) {
    return {
      label: source.label ?? "Collective Memory",
      content: "",
      tokens: 0,
      source,
    };
  }

  const memory: CollectiveMemory = loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
  if (memory.entries.length === 0) {
    return {
      label: source.label ?? "Collective Memory",
      content: "",
      tokens: 0,
      source,
    };
  }

  const budget = source.maxTokens ?? DEFAULT_BUDGET;
  const content = formatEntries(memory, budget);

  return {
    label: source.label ?? "Collective Memory",
    content,
    tokens: 0, // hydrator estimates tokens
    source,
  };
}

/**
 * Creates a collective memory source resolver that closes over a ForgeStore.
 *
 * Use this when registering as a custom resolver in ContextHydratorOptions.
 */
export function createCollectiveMemoryResolver(forgeStore: ForgeStore): SourceResolver {
  return async (source, agent) => {
    const cmSource = source as CollectiveMemoryContextSource;
    const brickIdStr = cmSource.brickId ?? agent.manifest.name;
    const loadResult = await forgeStore.load(brickIdStr as BrickId);

    if (!loadResult.ok) {
      return {
        label: source.label ?? "Collective Memory",
        content: "",
        tokens: 0,
        source,
      };
    }

    const memory: CollectiveMemory = loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
    if (memory.entries.length === 0) {
      return {
        label: source.label ?? "Collective Memory",
        content: "",
        tokens: 0,
        source,
      };
    }

    const budget = source.maxTokens ?? DEFAULT_BUDGET;
    const content = formatEntries(memory, budget);

    return {
      label: source.label ?? "Collective Memory",
      content,
      tokens: 0,
      source,
    };
  };
}
