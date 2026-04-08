/**
 * @koi/tools-builtin — Built-in tools for Koi agents.
 *
 * Filesystem tools: primordial Tool instances backed by FileSystemBackend.
 * Search tools: glob, grep, tool-search for codebase exploration.
 * Interaction tools: plan-mode (enter/exit), ask-user, todo.
 */

// Search tools
export type { BuiltinSearchProviderConfig } from "./builtin-search-provider.js";
export { createBuiltinSearchProvider } from "./builtin-search-provider.js";
export type { BuiltinSearchOperation } from "./constants.js";
export { BUILTIN_SEARCH_OPERATIONS } from "./constants.js";
// Credential path guard
export type { PathGuardResult } from "./credential-path-guard.js";
export { createCredentialPathGuard } from "./credential-path-guard.js";
export type { GlobToolConfig } from "./glob-tool.js";
export { createGlobTool } from "./glob-tool.js";
export type { GrepToolConfig } from "./grep-tool.js";
export { createGrepTool } from "./grep-tool.js";
// Filesystem tools
export type { ParseResult } from "./parse-args.js";
export type { ToolSearchConfig } from "./tool-search-tool.js";
export { createToolSearchTool } from "./tool-search-tool.js";
// Interaction tools
export type { AskUserToolConfig } from "./tools/ask-user.js";
export { createAskUserTool } from "./tools/ask-user.js";
export { createFsEditTool } from "./tools/edit.js";
export type {
  EnterPlanModeConfig,
  ExitPlanModeConfig,
  PlanApprovalRequest,
} from "./tools/plan-mode.js";
export { createEnterPlanModeTool, createExitPlanModeTool } from "./tools/plan-mode.js";
export type { FsToolOptions } from "./tools/read.js";
export { createFsReadTool } from "./tools/read.js";
export type { TodoItem, TodoStatus, TodoToolConfig } from "./tools/todo.js";
export { createTodoTool } from "./tools/todo.js";
export { createFsWriteTool } from "./tools/write.js";
