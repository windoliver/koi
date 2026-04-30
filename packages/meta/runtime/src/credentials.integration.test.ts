/**
 * Integration test for the gov-15 credentials scope wiring.
 *
 * Composes the env-var producer (`createEnvCredentials`) with the scope
 * wrapper (`createScopedCredentials` from `@koi/governance-scope`) and
 * verifies that brick activation's `validateCredentialRequires` honours
 * the manifest-declared allowlist:
 *
 *   - Keys matching an allow glob resolve to the underlying env value.
 *   - Keys outside the allowlist resolve to `undefined`, so the brick's
 *     `requires.credentials` check fails closed with a VALIDATION error.
 *   - Required keys with an empty `ref` are flagged as missing (regression
 *     guard against the case where a manifest omits the env binding).
 */

import { describe, expect, test } from "bun:test";
import type { BrickRequires } from "@koi/core";
import { createScopedCredentials } from "@koi/governance-scope";
import { validateCredentialRequires } from "@koi/validation";

import { createEnvCredentials } from "./credentials.js";

function buildScopedCreds(allow: readonly string[]): ReturnType<typeof createScopedCredentials> {
  const base = createEnvCredentials({
    env: {
      KOI_CRED_OPENAI_API_KEY: "sk-openai",
      KOI_CRED_STRIPE_SECRET: "sk-stripe",
      KOI_CRED_BLOCKED_KEY: "should-never-leak",
    },
  });
  return createScopedCredentials(base, { allow });
}

describe("credentials scope + validateCredentialRequires", () => {
  const requires: BrickRequires = {
    credentials: {
      OpenAI: { kind: "api_key", ref: "openai_api_key" },
    },
  };

  test("allowed key resolves and validation passes", async () => {
    const creds = buildScopedCreds(["openai_*"]);
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(true);
  });

  test("blocked key returns undefined and validation fails closed", async () => {
    const creds = buildScopedCreds(["stripe_*"]);
    const result = await validateCredentialRequires(requires, creds);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("OpenAI");
  });

  test("multi-key brick: one allowed, one blocked → both surfaced", async () => {
    const multiRequires: BrickRequires = {
      credentials: {
        OpenAI: { kind: "api_key", ref: "openai_api_key" },
        Stripe: { kind: "api_key", ref: "stripe_secret" },
        Blocked: { kind: "api_key", ref: "blocked_key" },
      },
    };
    const creds = buildScopedCreds(["openai_*", "stripe_*"]);
    const result = await validateCredentialRequires(multiRequires, creds);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Blocked");
    expect(result.error.message).not.toContain("OpenAI");
    expect(result.error.message).not.toContain("Stripe");
  });

  test("scope returns undefined for non-matching keys without leaking the underlying value", async () => {
    const creds = buildScopedCreds(["openai_*"]);
    expect(await creds.get("blocked_key")).toBeUndefined();
    expect(await creds.get("stripe_secret")).toBeUndefined();
    expect(await creds.get("openai_api_key")).toBe("sk-openai");
  });

  test("undefined component (no manifest scope) trivially passes — backwards compat", async () => {
    const result = await validateCredentialRequires(requires, undefined);
    expect(result.ok).toBe(true);
  });

  test("empty-ref requirement is flagged regardless of scope", async () => {
    const emptyRefRequires: BrickRequires = {
      credentials: {
        OpenAI: { kind: "api_key", ref: "" },
      },
    };
    const creds = buildScopedCreds(["openai_*"]);
    const result = await validateCredentialRequires(emptyRefRequires, creds);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });
});
