import { describe, expect, test } from "bun:test";
import {
  ASSIGN_WORKER_TOOL_DESCRIPTOR,
  DEFAULT_ORCHESTRATOR_CONFIG,
  ORCHESTRATE_TOOL_DESCRIPTOR,
  REVIEW_OUTPUT_TOOL_DESCRIPTOR,
  SYNTHESIZE_TOOL_DESCRIPTOR,
} from "./types.js";

describe("DEFAULT_ORCHESTRATOR_CONFIG", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency).toBe(5);
    expect(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_ORCHESTRATOR_CONFIG.maxOutputPerTask).toBe(5000);
    expect(DEFAULT_ORCHESTRATOR_CONFIG.maxDurationMs).toBe(1_800_000);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_ORCHESTRATOR_CONFIG)).toBe(true);
  });
});

describe("tool descriptors", () => {
  test("ORCHESTRATE_TOOL_DESCRIPTOR has name and description", () => {
    expect(ORCHESTRATE_TOOL_DESCRIPTOR.name).toBe("orchestrate");
    expect(ORCHESTRATE_TOOL_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("ASSIGN_WORKER_TOOL_DESCRIPTOR has name and description", () => {
    expect(ASSIGN_WORKER_TOOL_DESCRIPTOR.name).toBe("assign_worker");
    expect(ASSIGN_WORKER_TOOL_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("REVIEW_OUTPUT_TOOL_DESCRIPTOR has name and description", () => {
    expect(REVIEW_OUTPUT_TOOL_DESCRIPTOR.name).toBe("review_output");
    expect(REVIEW_OUTPUT_TOOL_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("SYNTHESIZE_TOOL_DESCRIPTOR has name and description", () => {
    expect(SYNTHESIZE_TOOL_DESCRIPTOR.name).toBe("synthesize");
    expect(SYNTHESIZE_TOOL_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("all descriptors are frozen", () => {
    expect(Object.isFrozen(ORCHESTRATE_TOOL_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(ASSIGN_WORKER_TOOL_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(REVIEW_OUTPUT_TOOL_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(SYNTHESIZE_TOOL_DESCRIPTOR)).toBe(true);
  });
});
