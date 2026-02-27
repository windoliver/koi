/**
 * Tool factory for `web_fetch` — fetch a URL and return the response content.
 */

import type { JsonObject, Tool, TrustTier } from "@koi/core";
import { htmlToMarkdown } from "../html-to-markdown.js";
import { stripHtml } from "../strip-html.js";
import { isBlockedUrl } from "../url-policy.js";
import type { WebExecutor } from "../web-executor.js";
import { MAX_TIMEOUT_MS } from "../web-executor.js";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"] as const;
const ALLOWED_FORMATS = ["text", "markdown", "html"] as const;

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
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_fetch`,
      description:
        "Fetch a URL and return the response. Supports GET/POST/PUT/DELETE. " +
        "HTML content is converted to text or markdown by default. " +
        "Response body is truncated to ~50K chars. Private/internal URLs are blocked.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch (must be a public http/https URL)" },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          headers: {
            type: "object",
            description: "Request headers as key-value string pairs",
          },
          body: { type: "string", description: "Request body (for POST/PUT)" },
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
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      // Validate URL
      if (typeof args.url !== "string" || args.url.trim() === "") {
        return { error: "url must be a non-empty string", code: "VALIDATION" };
      }

      const url = args.url.trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "url must start with http:// or https://", code: "VALIDATION" };
      }

      // SSRF protection
      if (isBlockedUrl(url)) {
        return { error: "Access to private/internal URLs is blocked", code: "PERMISSION" };
      }

      // Validate method
      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
        return {
          error: `method must be one of: ${ALLOWED_METHODS.join(", ")}`,
          code: "VALIDATION",
        };
      }

      // Validate timeout
      const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
      if (timeout !== undefined && (timeout < 100 || timeout > MAX_TIMEOUT_MS)) {
        return { error: `timeout must be between 100 and ${MAX_TIMEOUT_MS}`, code: "VALIDATION" };
      }

      // Parse and validate headers
      const headers = parseHeaders(args.headers);
      if (args.headers !== undefined && headers === undefined) {
        return { error: "headers must be an object with string values", code: "VALIDATION" };
      }

      // Parse format (supports legacy strip_html for backwards compat)
      const format = resolveFormat(args);
      if (format === undefined) {
        return {
          error: `format must be one of: ${ALLOWED_FORMATS.join(", ")}`,
          code: "VALIDATION",
        };
      }

      // Parse body
      const body = typeof args.body === "string" ? args.body : undefined;

      const result = await executor.fetch(url, {
        method,
        headers,
        body,
        timeoutMs: timeout,
      });

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
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

type OutputFormat = "text" | "markdown" | "html";

function resolveFormat(args: JsonObject): OutputFormat | undefined {
  // New `format` param takes precedence
  if (typeof args.format === "string") {
    const f = args.format.toLowerCase();
    if (!(ALLOWED_FORMATS as readonly string[]).includes(f)) return undefined;
    return f as OutputFormat;
  }
  // Legacy `strip_html` compat: false → html, true/default → text
  if (typeof args.strip_html === "boolean") {
    return args.strip_html ? "text" : "html";
  }
  return "text";
}

function formatBody(body: string, isHtml: boolean, format: OutputFormat): string {
  if (!isHtml) return body;
  if (format === "html") return body;
  if (format === "markdown") return htmlToMarkdown(body);
  return stripHtml(body);
}
