/**
 * Tool factory for `web_fetch` — fetch a URL and return the response content.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { BLOCKED_HOST_SUFFIXES, BLOCKED_HOSTS, isBlockedIp } from "@koi/url-safety";
import { MAX_TIMEOUT_MS } from "./constants.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { stripHtml } from "./strip-html.js";
import type { WebExecutor } from "./web-executor.js";

/**
 * DNS-free pre-flight — catches obvious SSRF targets before any executor
 * call using ONLY @koi/url-safety's static constants. Deliberately avoids
 * DNS resolution so this decision can't disagree with the executor's
 * configured resolver on transient lookups. If this returns a reason, the
 * URL is definitively blocked regardless of DNS; if it returns undefined,
 * the executor (with its full DNS-backed isSafeUrl) is the final decision.
 */
export function preflightBlockReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (BLOCKED_HOSTS.includes(bare)) return `Blocked host ${bare}`;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (bare === suffix.slice(1) || bare.endsWith(suffix)) {
      return `Blocked reserved suffix ${suffix} for host ${bare}`;
    }
  }
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
  if (isIpLiteral && isBlockedIp(bare)) return `Blocked IP literal ${bare}`;
  return undefined;
}

const ALLOWED_METHODS = ["GET", "HEAD"] as const;
const ALLOWED_FORMATS = ["text", "markdown", "html"] as const;
type OutputFormat = "text" | "markdown" | "html";

function parseHeaders(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "string") return undefined;
    result[key] = value;
  }
  return result;
}

export function createWebFetchTool(
  executor: WebExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_fetch`,
      description:
        "Fetch a URL and return the response. " +
        "HTML content is converted to text or markdown by default. " +
        "Response body is truncated to ~50K chars. Private/internal URLs are blocked.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch (must be a public http/https URL)" },
          method: { type: "string", description: "HTTP method (default: GET)" },
          headers: { type: "object", description: "Request headers as key-value string pairs" },
          timeout: {
            type: "number",
            description: `Timeout in ms (default: 15000, max: ${MAX_TIMEOUT_MS})`,
          },
          format: {
            type: "string",
            description:
              "Output format for HTML: 'text' (plain text), 'markdown' (preserve structure), 'html' (raw). Default: 'text'",
          },
          noCache: {
            type: "boolean",
            description:
              "Force a live fetch with no stale fallback. Scope is cache-only: this flag does NOT rewrite HTTP error statuses into errors — a 500/429/404 response still returns normally so you can inspect status/body. What it guarantees: the pre-existing cached response for this URL is evicted before the request, a cacheable 200 refreshes the cache, and anything else (non-cacheable response, HTTP error, transport failure) leaves the key empty so the next default fetch also hits origin. Transport errors (network, timeout, SSRF block) still surface via the usual error object. Use when verifying a just-changed page: stale data is worse than no data. Default: false.",
          },
        },
        required: ["url"],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (typeof args.url !== "string" || args.url.trim() === "") {
        return { error: "url must be a non-empty string", code: "VALIDATION" };
      }
      const url = args.url.trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "url must start with http:// or https://", code: "VALIDATION" };
      }
      // DNS-free pre-flight — rejects obvious SSRF targets (blocked hosts,
      // reserved suffixes, private IP literals) before any executor call.
      // Does NOT resolve DNS, so it cannot disagree with the executor's
      // configured resolver on transient lookups. Defence-in-depth alongside
      // the executor's full isSafeUrl check for hostnames.
      const blockReason = preflightBlockReason(url);
      if (blockReason !== undefined) {
        return { error: `Access blocked: ${blockReason}`, code: "PERMISSION" };
      }
      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
        return {
          error: `method must be one of: ${ALLOWED_METHODS.join(", ")}`,
          code: "VALIDATION",
        };
      }
      const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
      if (timeout !== undefined && (timeout < 100 || timeout > MAX_TIMEOUT_MS)) {
        return { error: `timeout must be between 100 and ${MAX_TIMEOUT_MS}`, code: "VALIDATION" };
      }
      const headers = parseHeaders(args.headers);
      if (args.headers !== undefined && headers === undefined) {
        return { error: "headers must be an object with string values", code: "VALIDATION" };
      }
      const format = resolveFormat(args);
      if (format === undefined) {
        return {
          error: `format must be one of: ${ALLOWED_FORMATS.join(", ")}`,
          code: "VALIDATION",
        };
      }
      if (args.noCache !== undefined && typeof args.noCache !== "boolean") {
        return { error: "noCache must be a boolean", code: "VALIDATION" };
      }
      const noCache = args.noCache === true;

      const result = await executor.fetch(url, { method, headers, timeoutMs: timeout, noCache });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      const contentType = result.value.headers["content-type"] ?? "";
      const isHtml = contentType.includes("text/html");
      const outputBody = formatBody(result.value.body, isHtml, format);

      return {
        status: result.value.status,
        statusText: result.value.statusText,
        contentType,
        body: outputBody,
        format: isHtml ? format : "raw",
        truncated: result.value.truncated,
        finalUrl: result.value.finalUrl,
        cached: result.value.cached,
      };
    },
  };
}

function resolveFormat(args: JsonObject): OutputFormat | undefined {
  if (typeof args.format === "string") {
    const f = args.format.toLowerCase();
    if (!(ALLOWED_FORMATS as readonly string[]).includes(f)) return undefined;
    return f as OutputFormat;
  }
  return "text";
}

function formatBody(body: string, isHtml: boolean, format: OutputFormat): string {
  if (!isHtml) return body;
  if (format === "html") return body;
  if (format === "markdown") return htmlToMarkdown(body);
  return stripHtml(body);
}
