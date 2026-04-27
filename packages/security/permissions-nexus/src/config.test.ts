import { describe, expect, test } from "bun:test";
import type { KoiError, PermissionBackend, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { validateNexusPermissionsConfig } from "./config.js";

function makeTransport(): NexusTransport {
  return {
    call: async <T>(): Promise<Result<T, KoiError>> => ({ ok: true, value: "" as unknown as T }),
    close: () => {},
  };
}

function makeLocalBackend(): PermissionBackend {
  return {
    check: () => ({ effect: "allow" }),
  };
}

describe("validateNexusPermissionsConfig", () => {
  test("valid config returns ok: true", () => {
    const config = {
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
    };
    const result = validateNexusPermissionsConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(config);
    }
  });

  test("null returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("non-object returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig("string");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("missing transport returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("transport");
    }
  });

  test("null transport returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      transport: null,
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("transport");
    }
  });

  test("missing localBackend returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      rebuildBackend: () => makeLocalBackend(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("localBackend");
    }
  });

  test("non-function rebuildBackend returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("rebuildBackend");
    }
  });

  test("syncIntervalMs: 0 is valid (disables polling)", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("positive syncIntervalMs is valid", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 5000,
    });
    expect(result.ok).toBe(true);
  });

  test("negative syncIntervalMs returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("syncIntervalMs");
    }
  });

  test("non-number syncIntervalMs returns VALIDATION error", () => {
    const result = validateNexusPermissionsConfig({
      transport: makeTransport(),
      localBackend: makeLocalBackend(),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: "30000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});
