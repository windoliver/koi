import { describe, expect, test } from "bun:test";
import type { AttachResult, CredentialComponent } from "@koi/core";
import { COMPONENT_PRIORITY, CREDENTIALS, isAttachResult } from "@koi/core";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import {
  compileCredentialsScope,
  createScopedCredentials,
  createScopedCredentialsProvider,
} from "./scoped-credentials.js";

// ---------------------------------------------------------------------------
// Mock credential component
// ---------------------------------------------------------------------------

function createMockCredentials(store: Readonly<Record<string, string>>): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      return store[key];
    },
  };
}

// ---------------------------------------------------------------------------
// compileCredentialsScope
// ---------------------------------------------------------------------------

describe("compileCredentialsScope", () => {
  test("compiles wildcard suffix pattern", () => {
    const compiled = compileCredentialsScope({ keyPattern: "OPENAI_*" });
    expect(compiled.pattern.test("OPENAI_API_KEY")).toBe(true);
    expect(compiled.pattern.test("OPENAI_ORG")).toBe(true);
    expect(compiled.pattern.test("GOOGLE_API_KEY")).toBe(false);
  });

  test("compiles wildcard prefix pattern", () => {
    const compiled = compileCredentialsScope({ keyPattern: "*_SECRET" });
    expect(compiled.pattern.test("APP_SECRET")).toBe(true);
    expect(compiled.pattern.test("DB_SECRET")).toBe(true);
    expect(compiled.pattern.test("DB_KEY")).toBe(false);
  });

  test("compiles exact match pattern", () => {
    const compiled = compileCredentialsScope({ keyPattern: "MY_KEY" });
    expect(compiled.pattern.test("MY_KEY")).toBe(true);
    expect(compiled.pattern.test("MY_KEY_2")).toBe(false);
    expect(compiled.pattern.test("OTHER")).toBe(false);
  });

  test("compiles star-only pattern", () => {
    const compiled = compileCredentialsScope({ keyPattern: "*" });
    expect(compiled.pattern.test("ANY_KEY")).toBe(true);
    expect(compiled.pattern.test("")).toBe(true);
  });

  test("escapes regex special characters", () => {
    const compiled = compileCredentialsScope({ keyPattern: "key.name+test" });
    // Should NOT match "keyXname+test" — the dot should be literal
    expect(compiled.pattern.test("key.name+test")).toBe(true);
    expect(compiled.pattern.test("keyXname+test")).toBe(false);
  });

  test("preserves original pattern", () => {
    const compiled = compileCredentialsScope({ keyPattern: "OPENAI_*" });
    expect(compiled.originalPattern).toBe("OPENAI_*");
  });
});

// ---------------------------------------------------------------------------
// createScopedCredentials
// ---------------------------------------------------------------------------

describe("createScopedCredentials", () => {
  test("returns value for matching key", async () => {
    const creds = createMockCredentials({ OPENAI_KEY: "sk-123" });
    const scoped = createScopedCredentials(creds, { keyPattern: "OPENAI_*" });
    expect(await scoped.get("OPENAI_KEY")).toBe("sk-123");
  });

  test("returns undefined for non-matching key", async () => {
    const creds = createMockCredentials({ GOOGLE_KEY: "gk-456" });
    const scoped = createScopedCredentials(creds, { keyPattern: "OPENAI_*" });
    expect(await scoped.get("GOOGLE_KEY")).toBeUndefined();
  });

  test("handles case sensitivity correctly", async () => {
    const creds = createMockCredentials({ openai_key: "sk-123" });
    const scoped = createScopedCredentials(creds, { keyPattern: "OPENAI_*" });
    // Pattern is case-sensitive — lowercase key doesn't match uppercase pattern
    expect(await scoped.get("openai_key")).toBeUndefined();
  });

  test("wildcard matches multiple keys", async () => {
    const creds = createMockCredentials({ A_KEY: "a", B_KEY: "b", A_SECRET: "s" });
    const scoped = createScopedCredentials(creds, { keyPattern: "A_*" });
    expect(await scoped.get("A_KEY")).toBe("a");
    expect(await scoped.get("A_SECRET")).toBe("s");
    expect(await scoped.get("B_KEY")).toBeUndefined();
  });

  test("empty pattern matches nothing", async () => {
    const creds = createMockCredentials({ KEY: "val" });
    const scoped = createScopedCredentials(creds, { keyPattern: "" });
    // Empty string pattern: ^$ matches only empty string
    expect(await scoped.get("KEY")).toBeUndefined();
    expect(await scoped.get("")).toBeUndefined();
  });

  test("star pattern matches everything", async () => {
    const creds = createMockCredentials({ A: "1", B: "2", C: "3" });
    const scoped = createScopedCredentials(creds, { keyPattern: "*" });
    expect(await scoped.get("A")).toBe("1");
    expect(await scoped.get("B")).toBe("2");
    expect(await scoped.get("C")).toBe("3");
  });

  test("special characters in key name handled", async () => {
    const creds = createMockCredentials({ "key.with.dots": "val" });
    const scoped = createScopedCredentials(creds, { keyPattern: "key.with.*" });
    expect(await scoped.get("key.with.dots")).toBe("val");
  });
});

// ---------------------------------------------------------------------------
// createScopedCredentialsProvider
// ---------------------------------------------------------------------------

describe("createScopedCredentialsProvider", () => {
  test("attaches scoped credentials under CREDENTIALS token", async () => {
    const creds = createMockCredentials({ OPENAI_KEY: "sk-123" });
    const provider = createScopedCredentialsProvider(creds, { keyPattern: "OPENAI_*" });
    const agent = {} as Parameters<typeof provider.attach>[0];
    const components = extractMap(await provider.attach(agent));
    expect(components.has(CREDENTIALS as string)).toBe(true);
    const scoped = components.get(CREDENTIALS as string) as CredentialComponent;
    expect(await scoped.get("OPENAI_KEY")).toBe("sk-123");
  });

  test("uses AGENT_FORGED priority", () => {
    const creds = createMockCredentials({});
    const provider = createScopedCredentialsProvider(creds, { keyPattern: "*" });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});
