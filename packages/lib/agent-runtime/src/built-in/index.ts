/**
 * Built-in agent definitions — bundled as string constants.
 *
 * Agent content is embedded as template literals in .ts files (not .md imports)
 * to ensure compatibility with the tsup/esbuild build pipeline.
 * Parsed once on first access via the parseAgentDefinition pipeline.
 */

import type { AgentDefinition } from "@koi/core";

import { deepFreezeDefinition } from "../freeze.js";
import { parseAgentDefinition } from "../parse-agent-definition.js";
import { CODER_MD } from "./coder.js";
import { COORDINATOR_MANIFEST } from "./coordinator.js";
import { RESEARCHER_MD } from "./researcher.js";
import { REVIEWER_MD } from "./reviewer.js";

interface BuiltInEntry {
  readonly name: string;
  readonly content: string;
}

// Coordinator is pre-parsed at module load in coordinator.ts — excluded from this list.
const BUILT_IN_ENTRIES_MD: readonly BuiltInEntry[] = [
  { name: "researcher", content: RESEARCHER_MD },
  { name: "coder", content: CODER_MD },
  { name: "reviewer", content: REVIEWER_MD },
];

let cached: readonly AgentDefinition[] | undefined;

/**
 * Returns all built-in agent definitions.
 *
 * Researcher, coder, and reviewer are parsed on first call, then cached.
 * Coordinator is pre-parsed at module load (COORDINATOR_MANIFEST) — no re-parsing.
 * Throws if any built-in fails to parse (indicates a packaging bug).
 */
export function getBuiltInAgents(): readonly AgentDefinition[] {
  if (cached) return cached;

  const agents: AgentDefinition[] = [];
  for (const entry of BUILT_IN_ENTRIES_MD) {
    const result = parseAgentDefinition(entry.content, "built-in");
    if (!result.ok) {
      throw new Error(`Built-in agent "${entry.name}" failed to parse: ${result.error.message}`);
    }
    agents.push(deepFreezeDefinition(result.value));
  }
  agents.push(COORDINATOR_MANIFEST);

  const frozen: readonly AgentDefinition[] = Object.freeze(agents);
  cached = frozen;
  return frozen;
}

/** Number of built-in agents bundled in this package. */
export const BUILT_IN_AGENT_COUNT = 4;
