export type { AgentMounter, AgentMounterConfig, AgentProvider } from "./agent-mounter.js";
export { createAgentMounter } from "./agent-mounter.js";
export type { EntryName } from "./entries/index.js";
export { buildAgentEntries, ENTRY_NAMES } from "./entries/index.js";
export type { ProcFsConfig } from "./procfs-impl.js";
export { createProcFs } from "./procfs-impl.js";
