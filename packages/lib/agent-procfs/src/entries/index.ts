import type { Agent, AgentRegistry, ProcEntry, WritableProcEntry } from "@koi/core";
import { childrenEntry } from "./children.js";
import { configEntry } from "./config.js";
import { envEntry } from "./env.js";
import { metricsEntry } from "./metrics.js";
import { middlewareEntry } from "./middleware.js";
import { statusEntry } from "./status.js";
import { toolsEntry } from "./tools.js";

export const ENTRY_NAMES = [
  "status",
  "tools",
  "middleware",
  "children",
  "config",
  "env",
  "metrics",
] as const;

export type EntryName = (typeof ENTRY_NAMES)[number];

export function buildAgentEntries(
  agent: Agent,
  registry: AgentRegistry,
): Readonly<Record<EntryName, ProcEntry | WritableProcEntry>> {
  return {
    status: statusEntry(agent, registry),
    tools: toolsEntry(agent),
    middleware: middlewareEntry(agent),
    children: childrenEntry(agent, registry),
    config: configEntry(agent),
    env: envEntry(agent),
    metrics: metricsEntry(agent, registry),
  };
}
