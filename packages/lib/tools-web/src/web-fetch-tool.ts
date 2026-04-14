/**
 * Tool factory for `web_fetch` — fetch a URL and return the response content.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { MAX_TIMEOUT_MS } from "./constants.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { stripHtml } from "./strip-html.js";
import { isBlockedUrl } from "./url-policy.js";
import type { WebExecutor } from "./web-executor.js";

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
      if (isBlockedUrl(url)) {
        return { error: "Access to private/internal URLs is blocked", code: "PERMISSION" };
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

      const result = await executor.fetch(url, { method, headers, timeoutMs: timeout });
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
