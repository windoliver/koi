import { describe, expect, test } from "bun:test";
import { probeEnv } from "../../probes/env.js";

const DEFAULT_PATTERNS = ["*DATABASE_URL*", "*_DSN", "*_CONNECTION_STRING"];

describe("probeEnv", () => {
  test("matches DATABASE_URL pattern and infers postgres protocol", () => {
    const results = probeEnv(
      { DATABASE_URL: "postgres://user:pass@host:5432/db" },
      DEFAULT_PATTERNS,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("env");
    expect(results[0]?.descriptor.protocol).toBe("postgres");
    expect(results[0]?.descriptor.name).toBe("database-url");
  });

  test("infers postgres from postgresql:// prefix", () => {
    const results = probeEnv({ MY_DATABASE_URL: "postgresql://host/db" }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.protocol).toBe("postgres");
  });

  test("infers mysql protocol", () => {
    const results = probeEnv({ APP_DATABASE_URL: "mysql://host/db" }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.protocol).toBe("mysql");
  });

  test("infers sqlite protocol", () => {
    const results = probeEnv({ LOCAL_DATABASE_URL: "sqlite:///path/to/db" }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.protocol).toBe("sqlite");
  });

  test("skips empty values", () => {
    const results = probeEnv({ DATABASE_URL: "" }, DEFAULT_PATTERNS);

    expect(results).toEqual([]);
  });

  test("skips undefined values", () => {
    const results = probeEnv({ DATABASE_URL: undefined }, DEFAULT_PATTERNS);

    expect(results).toEqual([]);
  });

  test("skips variables with unrecognized protocol", () => {
    const results = probeEnv({ DATABASE_URL: "redis://host:6379" }, DEFAULT_PATTERNS);

    expect(results).toEqual([]);
  });

  test("never includes actual credential value in descriptor", () => {
    const secretUrl = "postgres://admin:s3cret@prod-db.internal:5432/myapp";
    const results = probeEnv({ DATABASE_URL: secretUrl }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
    const descriptor = results[0]?.descriptor;
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("admin");
    // Auth ref should point to the env var name, not the value
    expect(descriptor?.auth?.ref).toBe("DATABASE_URL");
  });

  test("matches *_DSN pattern", () => {
    const results = probeEnv({ SENTRY_DSN: "postgres://host/db" }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
  });

  test("matches *_CONNECTION_STRING pattern", () => {
    const results = probeEnv({ DB_CONNECTION_STRING: "mysql://host/db" }, DEFAULT_PATTERNS);

    expect(results).toHaveLength(1);
  });
});
