/**
 * @koi/tools-web — Web fetch and search tools for Koi agents.
 */

export type { WebOperation } from "./constants.js";
export {
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  WEB_OPERATIONS,
} from "./constants.js";
export { htmlToMarkdown } from "./html-to-markdown.js";
export { stripHtml } from "./strip-html.js";
// SSRF primitives moved to @koi/url-safety — import from there directly.
// @koi/tools-web now routes all outbound HTTP through createSafeFetcher.
export type {
  DnsResolverFn,
  SearchProvider,
  WebExecutor,
  WebExecutorConfig,
  WebFetchOptions,
  WebFetchResult,
  WebSearchOptions,
  WebSearchResult,
} from "./web-executor.js";
export { createWebExecutor } from "./web-executor.js";
export { createWebFetchTool } from "./web-fetch-tool.js";
export type { WebProviderConfig } from "./web-provider.js";
export { createWebProvider } from "./web-provider.js";
export { createWebSearchTool } from "./web-search-tool.js";
