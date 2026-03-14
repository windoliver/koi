import { describe, expect, test } from "bun:test";
import type { BrickRequires, CredentialComponent } from "@koi/core";
import { validateBrickRequires, validateCredentialRequires } from "./brick-requires.js";

describe("validateBrickRequires", () => {
  test("returns ok when requires is undefined", () => {
    const result = validateBrickRequires(undefined);
    expect(result.ok).toBe(true);
  });

  test("returns ok when requires is empty", () => {
    const result = validateBrickRequires({});
    expect(result.ok).toBe(true);
  });

  test("returns ok when current platform is in list", () => {
    const requires: BrickRequires = { platform: [process.platform] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(true);
  });

  test("returns error when current platform is not in list", () => {
    const requires: BrickRequires = { platform: ["freebsd"] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Unsupported platform");
      expect(result.error.context).toEqual({ kind: "platform", name: process.platform });
    }
  });

  test("returns ok for empty platform array (no restriction)", () => {
    const requires: BrickRequires = { platform: [] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(true);
  });

  test("returns ok when required bin exists", () => {
    // "bun" should exist in test environment
    const requires: BrickRequires = { bins: ["bun"] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(true);
  });

  test("returns error when required bin is missing", () => {
    const requires: BrickRequires = { bins: ["nonexistent-binary-xyz"] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("nonexistent-binary-xyz");
      expect(result.error.context).toEqual({ kind: "bin", name: "nonexistent-binary-xyz" });
    }
  });

  test("returns ok when required env var is set", () => {
    const requires: BrickRequires = { env: ["PATH"] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(true);
  });

  test("returns error when required env var is missing", () => {
    const requires: BrickRequires = { env: ["KOI_NONEXISTENT_VAR_XYZ"] };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("KOI_NONEXISTENT_VAR_XYZ");
    }
  });

  test("checks bins before env before platform (fail-fast order)", () => {
    const requires: BrickRequires = {
      bins: ["nonexistent-binary-xyz"],
      env: ["KOI_NONEXISTENT_VAR"],
      platform: ["freebsd"],
    };
    const result = validateBrickRequires(requires);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should fail on bins first
      expect(result.error.context).toEqual({ kind: "bin", name: "nonexistent-binary-xyz" });
    }
  });
});

// ---------------------------------------------------------------------------
// validateCredentialRequires
// ---------------------------------------------------------------------------

function mockCredentialComponent(store: Readonly<Record<string, string>>): CredentialComponent {
  return {
    get: async (key: string): Promise<string | undefined> => store[key],
  };
}

describe("validateCredentialRequires", () => {
  test("passes when all credentials are present", async () => {
    const requires: BrickRequires = {
      credentials: {
        db: { kind: "connection_string", ref: "DATABASE_URL" },
        api: { kind: "api_key", ref: "API_KEY" },
      },
    };
    const creds = mockCredentialComponent({
      DATABASE_URL: "postgres://localhost/test",
      API_KEY: "sk-1234",
    });
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(true);
  });

  test("returns all violations when multiple credentials are missing", async () => {
    const requires: BrickRequires = {
      credentials: {
        db: { kind: "connection_string", ref: "DATABASE_URL" },
        api: { kind: "api_key", ref: "API_KEY" },
        token: { kind: "bearer_token", ref: "TOKEN" },
      },
    };
    const creds = mockCredentialComponent({ DATABASE_URL: "postgres://localhost/test" });
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("api");
      expect(result.error.message).toContain("token");
      const violations = result.error.context?.violations as Array<{ kind: string; name: string }>;
      expect(violations).toHaveLength(2);
    }
  });

  test("treats empty string ref as missing", async () => {
    const requires: BrickRequires = {
      credentials: {
        db: { kind: "connection_string", ref: "" },
      },
    };
    const creds = mockCredentialComponent({});
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("db");
    }
  });

  test("propagates error when CredentialComponent.get() throws", async () => {
    const requires: BrickRequires = {
      credentials: {
        db: { kind: "connection_string", ref: "DATABASE_URL" },
      },
    };
    const creds: CredentialComponent = {
      get: async (): Promise<string | undefined> => {
        throw new Error("vault unreachable");
      },
    };
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("vault unreachable");
    }
  });

  test("passes trivially when credentials is empty object", async () => {
    const requires: BrickRequires = { credentials: {} };
    const creds = mockCredentialComponent({});
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(true);
  });

  test("skips credential check when no CredentialComponent provided (backward compat)", async () => {
    const requires: BrickRequires = {
      credentials: {
        db: { kind: "connection_string", ref: "DATABASE_URL" },
      },
    };
    const result = await validateCredentialRequires(requires, undefined);
    expect(result.ok).toBe(true);
  });
});
