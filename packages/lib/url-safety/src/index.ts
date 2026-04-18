/**
 * @koi/url-safety — SSRF / private-IP / metadata-endpoint blocklist (L0-utility).
 *
 * Used by every outbound HTTP in Koi to fail-closed on private ranges and
 * cloud metadata endpoints. Exports frozen data constants so downstream
 * packages (governance-security, tools-browser) can extend.
 */
export { BLOCKED_CIDR_RANGES, BLOCKED_HOSTS } from "./blocked.js";
export { isBlockedIp } from "./ip-classify.js";
export type { SafeFetcherOptions } from "./safe-fetcher.js";
export { createSafeFetcher } from "./safe-fetcher.js";
export type { DnsResolver, SafeUrlResult, UrlSafetyOptions } from "./safe-url.js";
export { isSafeUrl } from "./safe-url.js";
