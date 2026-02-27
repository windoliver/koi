import { describe, expect, test } from "bun:test";
import type { JsonObject, KoiError, Result } from "@koi/core";
import type { WebExecutor, WebFetchResult } from "../web-executor.js";
import { createWebFetchTool } from "./web-fetch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecutor(response: Result<WebFetchResult, KoiError>): WebExecutor {
  return {
    fetch: async () => response,
    search: async () => ({ ok: true, value: [] }),
  };
}

function successResponse(
  body: string,
  contentType = "text/plain",
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
    },
  };
}

function execute(executor: WebExecutor, args: JsonObject): Promise<unknown> {
  const tool = createWebFetchTool(executor, "web", "verified");
  return tool.execute(args);
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

describe("web_fetch descriptor", () => {
  test("has correct name and schema", () => {
    const executor = mockExecutor(successResponse(""));
    const tool = createWebFetchTool(executor, "web", "verified");
    expect(tool.descriptor.name).toBe("web_fetch");
    expect(tool.trustTier).toBe("verified");
    expect(tool.descriptor.inputSchema).toHaveProperty("required");
  });

  test("respects custom prefix", () => {
    const executor = mockExecutor(successResponse(""));
    const tool = createWebFetchTool(executor, "custom", "promoted");
    expect(tool.descriptor.name).toBe("custom_fetch");
    expect(tool.trustTier).toBe("promoted");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("web_fetch validation", () => {
  test("returns error for missing url", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, {})) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("url");
  });

  test("returns error for empty url", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, { url: "" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns error for non-http url", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, { url: "ftp://example.com" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("http");
  });

  test("returns error for invalid method", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, {
      url: "https://example.com",
      method: "INVALID",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("method");
  });

  test("returns error for invalid timeout", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, { url: "https://example.com", timeout: 50 })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("timeout");
  });

  test("returns error for non-string header values", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, {
      url: "https://example.com",
      headers: { Authorization: 123 },
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("headers");
  });

  test("returns error for invalid format", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, {
      url: "https://example.com",
      format: "xml",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("format");
  });
});

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

describe("web_fetch SSRF", () => {
  test("blocks localhost", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, { url: "http://localhost/admin" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("PERMISSION");
    expect(result.error).toContain("blocked");
  });

  test("blocks AWS metadata", async () => {
    const executor = mockExecutor(successResponse(""));
    const result = (await execute(executor, {
      url: "http://169.254.169.254/latest/meta-data/",
    })) as Record<string, unknown>;
    expect(result.code).toBe("PERMISSION");
  });
});

// ---------------------------------------------------------------------------
// Content handling
// ---------------------------------------------------------------------------

describe("web_fetch content", () => {
  test("returns plain text content as-is", async () => {
    const executor = mockExecutor(successResponse("Hello, world!"));
    const result = (await execute(executor, { url: "https://example.com" })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe(200);
    expect(result.body).toBe("Hello, world!");
    expect(result.truncated).toBe(false);
  });

  test("strips HTML by default (format=text)", async () => {
    const html = "<html><body><h1>Title</h1><p>Hello</p></body></html>";
    const executor = mockExecutor(successResponse(html, "text/html; charset=utf-8"));
    const result = (await execute(executor, { url: "https://example.com" })) as Record<
      string,
      unknown
    >;
    const body = result.body as string;
    expect(body).toContain("Title");
    expect(body).toContain("Hello");
    expect(body).not.toContain("<h1>");
    expect(result.format).toBe("text");
  });

  test("converts HTML to markdown when format=markdown", async () => {
    const html =
      '<h1>Title</h1><p>A <strong>bold</strong> paragraph with <a href="https://link.com">link</a>.</p>';
    const executor = mockExecutor(successResponse(html, "text/html"));
    const result = (await execute(executor, {
      url: "https://example.com",
      format: "markdown",
    })) as Record<string, unknown>;
    const body = result.body as string;
    expect(body).toContain("# Title");
    expect(body).toContain("**bold**");
    expect(body).toContain("[link](https://link.com)");
    expect(result.format).toBe("markdown");
  });

  test("preserves HTML when format=html", async () => {
    const html = "<h1>Title</h1>";
    const executor = mockExecutor(successResponse(html, "text/html"));
    const result = (await execute(executor, {
      url: "https://example.com",
      format: "html",
    })) as Record<string, unknown>;
    expect(result.body).toBe("<h1>Title</h1>");
    expect(result.format).toBe("html");
  });

  test("legacy strip_html=false maps to format=html", async () => {
    const html = "<h1>Title</h1>";
    const executor = mockExecutor(successResponse(html, "text/html"));
    const result = (await execute(executor, {
      url: "https://example.com",
      strip_html: false,
    })) as Record<string, unknown>;
    expect(result.body).toBe("<h1>Title</h1>");
  });

  test("non-HTML content returns format=raw", async () => {
    const executor = mockExecutor(successResponse('{"key":"value"}', "application/json"));
    const result = (await execute(executor, { url: "https://api.example.com" })) as Record<
      string,
      unknown
    >;
    expect(result.format).toBe("raw");
  });

  test("includes finalUrl in response", async () => {
    const executor = mockExecutor(successResponse("ok"));
    const result = (await execute(executor, { url: "https://example.com" })) as Record<
      string,
      unknown
    >;
    expect(result.finalUrl).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("web_fetch errors", () => {
  test("returns error from executor failure", async () => {
    const executor: WebExecutor = {
      fetch: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "Request timed out", retryable: true },
      }),
      search: async () => ({ ok: true, value: [] }),
    };
    const result = (await execute(executor, { url: "https://example.com" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("TIMEOUT");
    expect(result.error).toContain("timed out");
  });

  test("passes method and body to executor", async () => {
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    const executor: WebExecutor = {
      fetch: async (_url, options) => {
        capturedMethod = options?.method;
        capturedBody = options?.body;
        return successResponse("ok");
      },
      search: async () => ({ ok: true, value: [] }),
    };
    await execute(executor, {
      url: "https://api.example.com/data",
      method: "post",
      body: '{"key":"value"}',
    });
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toBe('{"key":"value"}');
  });
});
