import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { validateNexusAuditSinkConfig } from "./config.js";

function makeTransport(): NexusTransport {
  return {
    call: async <T>(
      _method: string,
      _params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> =>
      Promise.resolve<Result<unknown, KoiError>>({ ok: true, value: undefined }) as Promise<
        Result<T, KoiError>
      >,
    close: () => {},
  };
}

describe("validateNexusAuditSinkConfig", () => {
  test("valid config returns ok: true", () => {
    const config = { transport: makeTransport() };
    const result = validateNexusAuditSinkConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(config);
    }
  });

  test("null returns VALIDATION error", () => {
    const result = validateNexusAuditSinkConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("non-object returns VALIDATION error", () => {
    const result = validateNexusAuditSinkConfig("string");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("missing transport returns VALIDATION error", () => {
    const result = validateNexusAuditSinkConfig({ batchSize: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("transport");
    }
  });

  test("batchSize: 0 returns VALIDATION error", () => {
    const result = validateNexusAuditSinkConfig({ transport: makeTransport(), batchSize: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("batchSize");
    }
  });

  test("batchSize: 1 is valid", () => {
    const result = validateNexusAuditSinkConfig({ transport: makeTransport(), batchSize: 1 });
    expect(result.ok).toBe(true);
  });

  test("negative batchSize returns VALIDATION error", () => {
    const result = validateNexusAuditSinkConfig({ transport: makeTransport(), batchSize: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("valid config with all optional fields", () => {
    const result = validateNexusAuditSinkConfig({
      transport: makeTransport(),
      basePath: "custom/path",
      batchSize: 10,
      flushIntervalMs: 2000,
    });
    expect(result.ok).toBe(true);
  });
});
