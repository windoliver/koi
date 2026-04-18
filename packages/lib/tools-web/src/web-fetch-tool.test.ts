import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { WebExecutor, WebFetchResult } from "./web-executor.js";
import { createWebFetchTool } from "./web-fetch-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse(
  body: string,
  contentType: string,
  extras?: Partial<WebFetchResult>,
): Result<WebFetchResult, KoiError> {
  return {
    ok: true,
    value: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": contentType },
      body,
      truncated: false,
      finalUrl: "https://example.com",
      cached: false,
      ...extras,
    },
  };
}

function mockExecutor(response: Result<WebFetchResult, KoiError>): WebExecutor {
  return {
    fetch: async () => response,
    search: async () => ({
      ok: false,
      error: { code: "VALIDATION", message: "Not implemented", retryable: false },
    }),
  };
}

const POLICY = DEFAULT_UNSANDBOXED_POLICY;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebFetchTool", () => {
  describe("descriptor", () => {
    test("has correct name with prefix", () => {
      const tool = createWebFetchTool(
        mockExecutor(successResponse("", "text/plain")),
        "web",
        POLICY,
      );
      expect(tool.descriptor.name).toBe("web_fetch");
    });

    test("uses custom prefix", () => {
      const tool = createWebFetchTool(
        mockExecutor(successResponse("", "text/plain")),
        "custom",
        POLICY,
      );
      expect(tool.descriptor.name).toBe("custom_fetch");
    });
  });

  describe("validation", () => {
    const tool = createWebFetchTool(
      mockExecutor(successResponse("ok", "text/plain")),
      "web",
      POLICY,
    );

    test("rejects missing url", async () => {
      const result = (await tool.execute({})) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("url");
    });

    test("rejects empty url", async () => {
      const result = (await tool.execute({ url: "" })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
    });

    test("rejects non-http URL", async () => {
      const result = (await tool.execute({ url: "ftp://example.com" })) as {
        error: string;
        code: string;
      };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("http");
    });

    test("rejects invalid method (POST)", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        method: "POST",
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("GET");
    });

    test("rejects invalid method (PUT)", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        method: "PUT",
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
    });

    test("rejects invalid timeout", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        timeout: 10,
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("timeout");
    });

    test("rejects non-string headers", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        headers: { key: 123 },
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("headers");
    });

    test("rejects invalid format", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        format: "xml",
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("format");
    });

    test("rejects non-boolean noCache", async () => {
      const result = (await tool.execute({
        url: "https://example.com",
        noCache: "yes",
      })) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("noCache");
    });
  });

  describe("noCache flag", () => {
    test("forwards noCache=true to the executor", async () => {
      let captured: { readonly noCache: boolean | undefined } | undefined;
      const executor: WebExecutor = {
        fetch: async (_url, options) => {
          captured = { noCache: options?.noCache };
          return successResponse("ok", "text/plain");
        },
        search: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "n/a", retryable: false },
        }),
      };
      const tool = createWebFetchTool(executor, "web", POLICY);
      await tool.execute({ url: "https://example.com", noCache: true });
      expect(captured?.noCache).toBe(true);
    });

    test("omits noCache when caller does not set it (executor default applies)", async () => {
      let captured: { readonly noCache: boolean | undefined } | undefined;
      const executor: WebExecutor = {
        fetch: async (_url, options) => {
          captured = { noCache: options?.noCache };
          return successResponse("ok", "text/plain");
        },
        search: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "n/a", retryable: false },
        }),
      };
      const tool = createWebFetchTool(executor, "web", POLICY);
      await tool.execute({ url: "https://example.com" });
      expect(captured?.noCache).toBe(false);
    });

    test("descriptor advertises noCache property", () => {
      const tool = createWebFetchTool(
        mockExecutor(successResponse("ok", "text/plain")),
        "web",
        POLICY,
      );
      const schema = tool.descriptor.inputSchema as {
        properties: Record<string, { type: string }>;
      };
      expect(schema.properties.noCache).toBeDefined();
      expect(schema.properties.noCache?.type).toBe("boolean");
    });
  });

  describe("SSRF protection", () => {
    const tool = createWebFetchTool(
      mockExecutor(successResponse("ok", "text/plain")),
      "web",
      POLICY,
    );

    test("blocks localhost", async () => {
      const result = (await tool.execute({ url: "http://localhost/admin" })) as {
        error: string;
        code: string;
      };
      expect(result.code).toBe("PERMISSION");
    });

    test("blocks AWS metadata endpoint", async () => {
      const result = (await tool.execute({
        url: "http://169.254.169.254/latest/meta-data/",
      })) as { error: string; code: string };
      expect(result.code).toBe("PERMISSION");
    });
  });

  describe("content handling", () => {
    test("returns plain text as-is", async () => {
      const tool = createWebFetchTool(
        mockExecutor(successResponse("Hello world", "text/plain")),
        "web",
        POLICY,
      );
      const result = (await tool.execute({ url: "https://example.com" })) as {
        body: string;
        format: string;
      };
      expect(result.body).toBe("Hello world");
      expect(result.format).toBe("raw");
    });

    test("strips HTML by default (text format)", async () => {
      const html = "<p>Hello <strong>world</strong></p>";
      const tool = createWebFetchTool(
        mockExecutor(successResponse(html, "text/html")),
        "web",
        POLICY,
      );
      const result = (await tool.execute({ url: "https://example.com" })) as {
        body: string;
        format: string;
      };
      expect(result.body).not.toContain("<p>");
      expect(result.body).toContain("Hello");
      expect(result.body).toContain("world");
      expect(result.format).toBe("text");
    });

    test("converts HTML to markdown when format=markdown", async () => {
      const html = "<h1>Title</h1><p>Body</p>";
      const tool = createWebFetchTool(
        mockExecutor(successResponse(html, "text/html")),
        "web",
        POLICY,
      );
      const result = (await tool.execute({
        url: "https://example.com",
        format: "markdown",
      })) as { body: string; format: string };
      expect(result.body).toContain("# Title");
      expect(result.format).toBe("markdown");
    });

    test("preserves raw HTML when format=html", async () => {
      const html = "<p>Hello <strong>world</strong></p>";
      const tool = createWebFetchTool(
        mockExecutor(successResponse(html, "text/html")),
        "web",
        POLICY,
      );
      const result = (await tool.execute({
        url: "https://example.com",
        format: "html",
      })) as { body: string; format: string };
      expect(result.body).toBe(html);
      expect(result.format).toBe("html");
    });

    test("returns raw body for non-HTML content", async () => {
      const json = '{"key":"value"}';
      const tool = createWebFetchTool(
        mockExecutor(successResponse(json, "application/json")),
        "web",
        POLICY,
      );
      const result = (await tool.execute({ url: "https://example.com" })) as {
        body: string;
        format: string;
      };
      expect(result.body).toBe(json);
      expect(result.format).toBe("raw");
    });

    test("includes finalUrl in response", async () => {
      const tool = createWebFetchTool(
        mockExecutor(
          successResponse("ok", "text/plain", { finalUrl: "https://example.com/redirected" }),
        ),
        "web",
        POLICY,
      );
      const result = (await tool.execute({ url: "https://example.com" })) as {
        finalUrl: string;
      };
      expect(result.finalUrl).toBe("https://example.com/redirected");
    });

    test("propagates cached flag from executor", async () => {
      const missTool = createWebFetchTool(
        mockExecutor(successResponse("ok", "text/plain", { cached: false })),
        "web",
        POLICY,
      );
      const miss = (await missTool.execute({ url: "https://example.com" })) as { cached: boolean };
      expect(miss.cached).toBe(false);

      const hitTool = createWebFetchTool(
        mockExecutor(successResponse("ok", "text/plain", { cached: true })),
        "web",
        POLICY,
      );
      const hit = (await hitTool.execute({ url: "https://example.com" })) as { cached: boolean };
      expect(hit.cached).toBe(true);
    });
  });

  describe("error handling", () => {
    test("propagates executor failure", async () => {
      const executor: WebExecutor = {
        fetch: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "Network error", retryable: true },
        }),
        search: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "Not implemented", retryable: false },
        }),
      };
      const tool = createWebFetchTool(executor, "web", POLICY);
      const result = (await tool.execute({ url: "https://example.com" })) as {
        error: string;
        code: string;
      };
      expect(result.code).toBe("EXTERNAL");
      expect(result.error).toBe("Network error");
    });

    test("passes HEAD method to executor", async () => {
      let capturedMethod: string | undefined;
      const executor: WebExecutor = {
        fetch: async (_url, options) => {
          capturedMethod = options?.method;
          return successResponse("", "text/plain");
        },
        search: async () => ({
          ok: false,
          error: { code: "VALIDATION", message: "Not implemented", retryable: false },
        }),
      };
      const tool = createWebFetchTool(executor, "web", POLICY);
      await tool.execute({ url: "https://example.com", method: "HEAD" });
      expect(capturedMethod).toBe("HEAD");
    });
  });
});
