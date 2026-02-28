/**
 * @koi/tool-squash — Agent-initiated phase-boundary compression (Layer 2)
 *
 * The agent calls `squash(phase, summary)` at natural phase boundaries.
 * Old messages are replaced with the agent's own summary (no LLM call),
 * originals are archived to SnapshotChainStore, and optionally facts are
 * extracted to memory.
 */

export type { SquashProviderBundle } from "./provider.js";
export { createSquashProvider } from "./provider.js";
export { SQUASH_SKILL, SQUASH_SKILL_NAME } from "./skill.js";
export type { SquashConfig, SquashResult } from "./types.js";
export { SQUASH_DEFAULTS, SQUASH_TOOL_DESCRIPTOR } from "./types.js";
