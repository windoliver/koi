export * from "@koi/mcp";
export type {
  McpServer,
  McpServerConfig as McpServerInstanceConfig,
  ToolCache,
  ToolCacheConfig,
  ToolCacheEntry,
} from "@koi/mcp-server";
// @koi/mcp-server collides with @koi/mcp on 'McpServerConfig'
export {
  createMcpServer,
  createStdioServerTransport,
  createToolCache,
  registerHandlers,
} from "@koi/mcp-server";

// @koi/tools-web, @koi/tools-github, @koi/code-mode collide on DEFAULT_PREFIX
// @koi/tools-web, @koi/tool-ask-user, @koi/tool-exec collide on DEFAULT_TIMEOUT_MS
// Use explicit re-exports to resolve

export * from "@koi/code-mode";
export * from "@koi/tool-ask-guide";
export * from "@koi/tool-ask-user";
export type { ExecToolConfig } from "@koi/tool-exec";
export {
  createExecProvider,
  createExecTool,
  DEFAULT_TIMEOUT_MS as EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_SKILL,
  EXEC_SKILL_CONTENT,
  EXEC_SKILL_NAME,
  EXEC_TOOL_DESCRIPTOR,
  MAX_TIMEOUT_MS as EXEC_MAX_TIMEOUT_MS,
} from "@koi/tool-exec";
export type {
  ChubGetResult,
  ChubSearchResult,
  ContextHubExecutor,
  ContextHubExecutorConfig,
  ContextHubOperation,
  ContextHubProviderConfig,
  Registry,
  RegistryDoc,
  RegistryDocLanguage,
  RegistryDocVersion,
  SearchIndex,
  SearchIndexEntry,
  SearchResult,
} from "@koi/tools-context-hub";
export {
  buildSearchIndex,
  CONTEXT_HUB_SKILL,
  CONTEXT_HUB_SKILL_CONTENT,
  CONTEXT_HUB_SKILL_NAME,
  createChubGetTool,
  createChubSearchTool,
  createContextHubExecutor,
  createContextHubProvider,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL_MS as CHUB_DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS as CHUB_DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES as CHUB_DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_TIMEOUT_MS as CHUB_DEFAULT_TIMEOUT_MS,
  OPERATIONS as CHUB_OPERATIONS,
  searchIndex,
  tokenize,
} from "@koi/tools-context-hub";
export type {
  GhExecuteOptions,
  GhExecutor,
  GhExecutorConfig,
  GithubOperation,
  GithubProviderConfig,
  MergeStrategy,
  MockGhResponse,
  ReviewAction,
  ReviewEvent,
} from "@koi/tools-github";
export {
  createGhExecutor,
  createGithubCiWaitTool,
  createGithubPrCreateTool,
  createGithubPrMergeTool,
  createGithubProvider,
  createGithubPrReviewTool,
  createGithubPrStatusTool,
  DEFAULT_CI_POLL_INTERVAL_MS,
  DEFAULT_CI_TIMEOUT_MS,
  DEFAULT_PREFIX as GITHUB_DEFAULT_PREFIX,
  GITHUB_SYSTEM_PROMPT,
  isRecord,
  MAX_CI_TIMEOUT_MS,
  MERGE_STRATEGIES,
  MIN_CI_POLL_INTERVAL_MS,
  mapErrorResult,
  OPERATIONS as GITHUB_OPERATIONS,
  parseGhError,
  parseGhJson,
  READ_OPERATIONS as GITHUB_READ_OPERATIONS,
  REVIEW_ACTIONS,
  REVIEW_EVENTS,
  WRITE_OPERATIONS as GITHUB_WRITE_OPERATIONS,
} from "@koi/tools-github";
export type {
  WebExecutor,
  WebExecutorConfig,
  WebFetchOptions,
  WebFetchResult,
  WebOperation,
  WebProviderConfig,
  WebSearchOptions,
  WebSearchResult,
} from "@koi/tools-web";
export {
  createWebExecutor,
  createWebFetchTool,
  createWebProvider,
  createWebSearchTool,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_PREFIX as WEB_DEFAULT_PREFIX,
  DEFAULT_TIMEOUT_MS as WEB_DEFAULT_TIMEOUT_MS,
  htmlToMarkdown,
  isBlockedUrl,
  MAX_TIMEOUT_MS as WEB_MAX_TIMEOUT_MS,
  OPERATIONS as WEB_OPERATIONS,
  READ_OPERATIONS as WEB_READ_OPERATIONS,
  stripHtml,
  WEB_SKILL,
  WEB_SKILL_CONTENT,
  WEB_SKILL_NAME,
  WEB_SYSTEM_PROMPT,
} from "@koi/tools-web";
