/**
 * @koi/tools-core — Tool type bridge, registry, and ComponentProvider adapter.
 *
 * Bridges rich tool definitions with the L0 Tool contract. Provides:
 * - buildTool(): validates and maps ToolDefinition → Tool
 * - assembleToolPool(): dedup + sort tools into a deterministic pool
 * - createToolComponentProvider(): wraps tools into a ComponentProvider
 */

export { buildTool } from "./build-tool.js";
export { assembleToolPool } from "./tool-pool.js";
export { createToolComponentProvider } from "./tool-provider.js";
export type { ToolComponentProviderConfig, ToolDefinition } from "./types.js";
