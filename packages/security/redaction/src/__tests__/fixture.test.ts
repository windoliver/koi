import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRedactor } from "../redactor.js";

interface FixtureEntry {
  readonly description: string;
  readonly input: unknown;
}

const fixturesPath = resolve(__dirname, "fixtures/log-entries.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8")) as readonly FixtureEntry[];

const r = createRedactor();

/** Safely navigate a nested unknown value. */
function dig(value: unknown, ...keys: readonly string[]): unknown {
  // let justified: accumulates the navigated value through the key path
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("fixture corpus", () => {
  test("fixture 0: API call with Bearer token — Authorization field redacted", () => {
    const result = r.redactObject(fixtures[0]?.input);
    expect(result.changed).toBe(true);
    expect(dig(result.value, "request", "headers", "Authorization")).toBe("[REDACTED]");
  });

  test("fixture 1: AWS credentials — access key redacted in value", () => {
    const result = r.redactObject(fixtures[1]?.input);
    expect(result.changed).toBe(true);
    const keyId = dig(result.value, "request", "config", "aws_access_key_id") as string;
    expect(keyId).toContain("[REDACTED]");
    expect(dig(result.value, "request", "config", "region")).toBe("us-east-1");
  });

  test("fixture 2: GitHub token in log message — value-pattern match", () => {
    const result = r.redactObject(fixtures[2]?.input);
    expect(result.changed).toBe(true);
    const msg = dig(result.value, "request", "message") as string;
    expect(msg).not.toContain("ghp_");
  });

  test("fixture 3: Mixed password field + Stripe key", () => {
    const result = r.redactObject(fixtures[3]?.input);
    expect(result.changed).toBe(true);
    expect(dig(result.value, "metadata", "password")).toBe("[REDACTED]");
    const paymentKey = dig(result.value, "metadata", "payment_key") as string;
    expect(paymentKey).not.toContain("sk_live_");
  });

  test("fixture 4: PEM private key in response", () => {
    const result = r.redactObject(fixtures[4]?.input);
    expect(result.changed).toBe(true);
    const cert = dig(result.value, "response", "certificate") as string;
    expect(cert).not.toContain("-----BEGIN");
  });

  test("all fixtures produce changed=true", () => {
    for (const fixture of fixtures) {
      const result = r.redactObject(fixture.input);
      expect(result.changed).toBe(true);
    }
  });
});
