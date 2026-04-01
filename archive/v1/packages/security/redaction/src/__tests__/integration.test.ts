import { describe, expect, test } from "bun:test";
import { createRedactor } from "../redactor.js";

describe("integration: createRedactor full pipeline", () => {
  const r = createRedactor();

  test("redacts nested object with mixed secrets and field names", () => {
    const input = {
      user: "alice",
      password: "my-password-123",
      config: {
        apiKey: `sk_live_${"x".repeat(24)}`,
        endpoint: "https://api.example.com",
        headers: {
          Authorization: "Bearer abc123def456ghi789",
          "Content-Type": "application/json",
        },
      },
      logs: [
        "Started at 10:00",
        "Using key AKIAIOSFODNN7EXAMPLE for auth",
        "Completed successfully",
      ],
    };

    const result = r.redactObject(input);
    expect(result.changed).toBe(true);

    const v = result.value as Record<string, unknown>;
    expect(v.user).toBe("alice");
    expect(v.password).toBe("[REDACTED]");

    const config = v.config as Record<string, unknown>;
    expect(config.apiKey).toBe("[REDACTED]");
    expect(config.endpoint).toBe("https://api.example.com");

    const headers = config.headers as Record<string, string>;
    // "Authorization" is a sensitive field name
    expect(headers.Authorization).toBe("[REDACTED]");

    const logs = v.logs as string[];
    expect(logs[0]).toBe("Started at 10:00");
    expect(logs[1]).toContain("[REDACTED]");
    expect(logs[1]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(logs[2]).toBe("Completed successfully");
  });

  test("redacts serialized JSON string with secrets", () => {
    const json = JSON.stringify({
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123",
      data: "hello",
    });
    const result = r.redactString(json);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("eyJ");
  });

  test("zero-config creates usable redactor", () => {
    const r2 = createRedactor();
    const result = r2.redactObject({ secret: "value", name: "test" });
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, string>).secret).toBe("[REDACTED]");
    expect((result.value as Record<string, string>).name).toBe("test");
  });

  test("custom censor function receives match details", () => {
    const r2 = createRedactor({
      censor: (match) => `[${match.kind.toUpperCase()}_FOUND]`,
    });
    const result = r2.redactString("key=AKIAIOSFODNN7EXAMPLE");
    expect(result.text).toContain("[AWS_ACCESS_KEY_FOUND]");
  });

  test("custom field censor differs from value censor", () => {
    const r2 = createRedactor({
      censor: "redact",
      fieldCensor: "mask",
    });
    const result = r2.redactObject({
      password: "my-long-secret",
      data: "AKIAIOSFODNN7EXAMPLE",
    });
    const v = result.value as Record<string, string>;
    expect(v.password).toBe("my-l***"); // mask
    expect(v.data).toContain("[REDACTED]"); // redact
  });

  test("handles deeply nested structure", () => {
    const deep = {
      a: { b: { c: { d: { e: { password: "deep-secret" } } } } },
    };
    const result = r.redactObject(deep);
    expect(result.changed).toBe(true);
    const innerE = (
      result.value as Record<
        string,
        Record<string, Record<string, Record<string, Record<string, Record<string, string>>>>>
      >
    ).a?.b?.c?.d?.e;
    expect(innerE?.password).toBe("[REDACTED]");
  });

  test("handles array of objects", () => {
    const arr = [
      { name: "alice", token: "secret-1" },
      { name: "bob", token: "secret-2" },
    ];
    const result = r.redactObject(arr);
    expect(result.changed).toBe(true);
    const v = result.value as Array<Record<string, string>>;
    expect(v[0]?.token).toBe("[REDACTED]");
    expect(v[1]?.token).toBe("[REDACTED]");
    expect(v[0]?.name).toBe("alice");
  });
});
