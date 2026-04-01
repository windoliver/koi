/**
 * @koi/tool-execution — Per-call tool execution middleware.
 *
 * Implements KoiMiddleware.wrapToolCall for abort propagation,
 * per-tool timeout enforcement, and deterministic error normalization.
 */

export type { ToolExecutionConfig } from "./tool-execution.js";
export { createToolExecution } from "./tool-execution.js";
