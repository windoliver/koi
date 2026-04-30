/**
 * @koi/tools-web — Web fetch and search tools for Koi agents.
 */

// SSRF primitives live in @koi/url-safety now — @koi/tools-web routes all
// outbound HTTP through createSafeFetcher. `isBlockedIp` is re-exported
// here so existing consumers (the repo's golden-replay tests, future
// downstream) don't immediately break when upgrading from the
// pre-migration url-policy.ts surface. The removed helpers
// (isBlockedUrl / pinResolvedIp / resolveAndValidateUrl /
// DnsValidationResult / PinnedUrl) have no direct equivalent — callers
// should import isSafeUrl / createSafeFetcher from @koi/url-safety.
export { isBlockedIp } from "@koi/url-safety";
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
export { createWebFetchTool, preflightBlockReason } from "./web-fetch-tool.js";
export type { WebProviderConfig } from "./web-provider.js";
export { createWebProvider } from "./web-provider.js";
export { createWebSearchTool } from "./web-search-tool.js";
