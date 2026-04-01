import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type {
  ChubGetResult,
  ChubSearchResult,
  ContextHubExecutor,
} from "../context-hub-executor.js";
import { createChubGetTool } from "./chub-get.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedExecutor(result: ChubGetResult): ContextHubExecutor {
  return {
    search: async () => ({ ok: true, value: [] }) as Result<readonly ChubSearchResult[], KoiError>,
    get: async () => ({ ok: true, value: result }),
  };
}

function failingGetExecutor(error: KoiError): ContextHubExecutor {
  return {
    search: async () => ({ ok: true, value: [] }),
    get: async () => ({ ok: false, error }),
  };
}

const FIXTURE_DOC: ChubGetResult = {
  id: "stripe/payments",
  content: "# Stripe Payments API\n\nAccept payments with Stripe.",
  language: "javascript",
  version: "2.0.0",
  truncated: false,
};

function createTool(
  executor: ContextHubExecutor = fixedExecutor(FIXTURE_DOC),
): ReturnType<typeof createChubGetTool> {
  return createChubGetTool(executor, "chub", DEFAULT_UNSANDBOXED_POLICY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChubGetTool", () => {
  // Descriptor
  test("descriptor has correct name and schema", () => {
    const tool = createTool();
    expect(tool.descriptor.name).toBe("chub_get");
    expect(tool.descriptor.inputSchema.required).toContain("id");
    expect(tool.origin).toBe("primordial");
  });

  // Happy path
  test("returns doc content for valid id", async () => {
    const tool = createTool();
    const output = (await tool.execute({ id: "stripe/payments", language: "javascript" })) as {
      id: string;
      content: string;
      language: string;
      version: string;
      truncated: boolean;
    };

    expect(output.id).toBe("stripe/payments");
    expect(output.content).toContain("Stripe");
    expect(output.language).toBe("javascript");
    expect(output.version).toBe("2.0.0");
    expect(output.truncated).toBe(false);
  });

  // Language variant
  test("passes language parameter to executor", async () => {
    let capturedLang: string | undefined;
    const capturingExecutor: ContextHubExecutor = {
      search: async () => ({ ok: true, value: [] }),
      get: async (_id, lang) => {
        capturedLang = lang;
        return { ok: true, value: FIXTURE_DOC };
      },
    };

    const tool = createChubGetTool(capturingExecutor, "chub", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ id: "stripe/payments", language: "python" });
    expect(capturedLang).toBe("python");
  });

  // Version selection
  test("passes version parameter to executor", async () => {
    let capturedVersion: string | undefined;
    const capturingExecutor: ContextHubExecutor = {
      search: async () => ({ ok: true, value: [] }),
      get: async (_id, _lang, ver) => {
        capturedVersion = ver;
        return { ok: true, value: FIXTURE_DOC };
      },
    };

    const tool = createChubGetTool(capturingExecutor, "chub", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ id: "stripe/payments", language: "javascript", version: "1.0.0" });
    expect(capturedVersion).toBe("1.0.0");
  });

  // Truncation
  test("reports truncated flag from executor", async () => {
    const truncatedDoc: ChubGetResult = {
      ...FIXTURE_DOC,
      truncated: true,
      content: "x".repeat(50_000),
    };
    const tool = createTool(fixedExecutor(truncatedDoc));
    const output = (await tool.execute({ id: "stripe/payments", language: "javascript" })) as {
      truncated: boolean;
    };

    expect(output.truncated).toBe(true);
  });

  // Validation
  test("returns validation error for empty id", async () => {
    const tool = createTool();
    const output = (await tool.execute({ id: "" })) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
  });

  test("returns validation error for missing id", async () => {
    const tool = createTool();
    const output = (await tool.execute({})) as { error: string; code: string };

    expect(output.code).toBe("VALIDATION");
  });

  // Error handling
  test("returns DOC_NOT_FOUND for nonexistent doc", async () => {
    const tool = createTool(
      failingGetExecutor({ code: "NOT_FOUND", message: "Doc not found", retryable: false }),
    );
    const output = (await tool.execute({ id: "nonexistent/doc" })) as {
      error: string;
      code: string;
    };

    expect(output.code).toBe("NOT_FOUND");
  });

  test("returns LANG_NOT_FOUND with available languages", async () => {
    const tool = createTool(
      failingGetExecutor({
        code: "NOT_FOUND",
        message: 'Language "ruby" not found. Available: javascript, python',
        retryable: false,
      }),
    );
    const output = (await tool.execute({ id: "stripe/payments", language: "ruby" })) as {
      error: string;
      code: string;
    };

    expect(output.code).toBe("NOT_FOUND");
    expect(output.error).toContain("Available");
  });

  test("returns REGISTRY_UNAVAILABLE when CDN is down", async () => {
    const tool = createTool(
      failingGetExecutor({ code: "EXTERNAL", message: "CDN down", retryable: true }),
    );
    const output = (await tool.execute({ id: "stripe/payments", language: "javascript" })) as {
      error: string;
      code: string;
    };

    expect(output.code).toBe("EXTERNAL");
  });

  test("returns TIMEOUT on timeout", async () => {
    const tool = createTool(
      failingGetExecutor({ code: "TIMEOUT", message: "Request timed out", retryable: true }),
    );
    const output = (await tool.execute({ id: "stripe/payments", language: "javascript" })) as {
      error: string;
      code: string;
    };

    expect(output.code).toBe("TIMEOUT");
  });
});
