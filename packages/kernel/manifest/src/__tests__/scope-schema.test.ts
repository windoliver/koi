import { describe, expect, test } from "bun:test";
import { rawManifestSchema } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = {
  name: "my-agent",
  version: "1.0.0",
  model: "anthropic:claude-sonnet-4-5-20250929",
} as const;

function parse(extra: Record<string, unknown> = {}): {
  success: boolean;
  data?: unknown;
  error?: unknown;
} {
  return rawManifestSchema.safeParse({ ...BASE, ...extra });
}

// ---------------------------------------------------------------------------
// scope schema validation
// ---------------------------------------------------------------------------

describe("scope schema validation", () => {
  test("accepts full scope config with all 4 tokens", () => {
    const result = parse({
      scope: {
        filesystem: { root: "/workspace/src", mode: "ro" },
        browser: {
          allowedDomains: ["docs.example.com"],
          blockPrivateAddresses: true,
          sandbox: false,
        },
        credentials: { keyPattern: "api_key_*" },
        memory: { namespace: "research-agent" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts partial scope config (filesystem only)", () => {
    const result = parse({
      scope: {
        filesystem: { root: "/workspace/src" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty scope (no tokens)", () => {
    const result = parse({ scope: {} });
    expect(result.success).toBe(true);
  });

  test("filesystem defaults mode to rw", () => {
    const result = parse({
      scope: { filesystem: { root: "/workspace" } },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const scope = data.scope as Record<string, unknown>;
    const fs = scope.filesystem as Record<string, unknown>;
    expect(fs.mode).toBe("rw");
  });

  test("filesystem accepts ro mode", () => {
    const result = parse({
      scope: { filesystem: { root: "/workspace", mode: "ro" } },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const scope = data.scope as Record<string, unknown>;
    const fs = scope.filesystem as Record<string, unknown>;
    expect(fs.mode).toBe("ro");
  });

  test("filesystem rejects invalid mode", () => {
    const result = parse({
      scope: { filesystem: { root: "/workspace", mode: "execute" } },
    });
    expect(result.success).toBe(false);
  });

  test("browser accepts allowedDomains", () => {
    const result = parse({
      scope: {
        browser: { allowedDomains: ["example.com", "*.docs.example.com"] },
      },
    });
    expect(result.success).toBe(true);
  });

  test("browser accepts sandbox boolean", () => {
    const result = parse({
      scope: { browser: { sandbox: true } },
    });
    expect(result.success).toBe(true);
  });

  test("browser rejects invalid sandbox value", () => {
    const result = parse({
      scope: { browser: { sandbox: "admin" } },
    });
    expect(result.success).toBe(false);
  });

  test("browser accepts allowedProtocols", () => {
    const result = parse({
      scope: { browser: { allowedProtocols: ["https:"] } },
    });
    expect(result.success).toBe(true);
  });

  test("browser accepts blockPrivateAddresses", () => {
    const result = parse({
      scope: { browser: { blockPrivateAddresses: false } },
    });
    expect(result.success).toBe(true);
  });

  test("credentials requires keyPattern string", () => {
    const result = parse({
      scope: { credentials: {} },
    });
    expect(result.success).toBe(false);
  });

  test("credentials accepts keyPattern", () => {
    const result = parse({
      scope: { credentials: { keyPattern: "OPENAI_*" } },
    });
    expect(result.success).toBe(true);
  });

  test("memory requires namespace string", () => {
    const result = parse({
      scope: { memory: {} },
    });
    expect(result.success).toBe(false);
  });

  test("memory accepts namespace", () => {
    const result = parse({
      scope: { memory: { namespace: "research-agent" } },
    });
    expect(result.success).toBe(true);
  });

  test("manifest without scope is valid", () => {
    const result = parse();
    expect(result.success).toBe(true);
  });
});
