import { describe, expect, test } from "bun:test";
import type { SupervisionConfig } from "./supervision.js";
import { validateSupervisionConfig } from "./validate-supervision.js";

describe("validateSupervisionConfig", () => {
  test("accepts minimal valid config", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(true);
  });

  test("accepts config with isolation set per child", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent", isolation: "in-process" },
        { name: "b", restart: "transient", isolation: "subprocess" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxRestarts", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: -1,
      maxRestartWindowMs: 60_000,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects zero maxRestartWindowMs", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 0,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate child names", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent" },
        { name: "a", restart: "transient" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("duplicate");
  });

  test("rejects empty child name", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [{ name: "", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });

  test("rejects unknown isolation value", () => {
    const config = {
      strategy: { kind: "one_for_one" as const },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent" as const, isolation: "remote" as unknown as "in-process" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });
});
