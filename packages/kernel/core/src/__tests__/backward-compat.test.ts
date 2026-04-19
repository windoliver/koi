/**
 * Backward compatibility fixture tests for @koi/core runtime constants.
 *
 * These tests assert that known-good values still exist. Current values
 * must be a SUPERSET of fixture values — additions are ok, removals fail.
 * This guards against accidental breaking changes to public API constants.
 */

import { describe, expect, test } from "bun:test";

import type { AgentDefinition, TaskableAgent } from "../index.js";
import {
  AGENT_DEFINITION_PRIORITY,
  // ID factories
  agentId,
  brickId,
  // Well-known tokens
  CREDENTIALS,
  chainId,
  // Error factories
  conflict,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  DEFAULT_SCHEDULER_CONFIG,
  DELEGATION,
  EVENTS,
  exitCodeForTransitionReason,
  external,
  FILESYSTEM,
  GOVERNANCE,
  internal,
  MEMORY,
  nodeId,
  notFound,
  permission,
  // Runtime constants
  RETRYABLE_DEFAULTS,
  rateLimit,
  runId,
  SCHEDULER,
  scheduleId,
  sessionId,
  snapshotId,
  staleRef,
  taskId,
  timeout,
  toolCallId,
  turnId,
  VALID_TRANSITIONS,
  validation,
  WEBHOOK,
} from "../index.js";

// ---------------------------------------------------------------------------
// RETRYABLE_DEFAULTS
// ---------------------------------------------------------------------------

describe("RETRYABLE_DEFAULTS backward compatibility", () => {
  const expectedEntries: ReadonlyArray<readonly [string, boolean]> = [
    ["VALIDATION", false],
    ["NOT_FOUND", false],
    ["PERMISSION", false],
    ["CONFLICT", true],
    ["RATE_LIMIT", true],
    ["TIMEOUT", true],
    ["EXTERNAL", false],
    ["INTERNAL", false],
    ["STALE_REF", false],
  ] as const;

  test("all 9 error codes exist with expected retryability", () => {
    for (const [code, retryable] of expectedEntries) {
      expect(RETRYABLE_DEFAULTS).toHaveProperty(code, retryable);
    }
  });

  test("has exactly 12 codes (no unexpected additions)", () => {
    // 12 after RESOURCE_EXHAUSTED and UNAVAILABLE were added for @koi/daemon (#1338)
    expect(Object.keys(RETRYABLE_DEFAULTS)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS
// ---------------------------------------------------------------------------

describe("VALID_TRANSITIONS backward compatibility", () => {
  test("all 6 process states exist", () => {
    const states = ["created", "running", "waiting", "suspended", "idle", "terminated"] as const;
    for (const state of states) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  test("created can transition to running and terminated", () => {
    expect(VALID_TRANSITIONS.created).toContain("running");
    expect(VALID_TRANSITIONS.created).toContain("terminated");
  });

  test("running can transition to waiting, suspended, idle, and terminated", () => {
    expect(VALID_TRANSITIONS.running).toContain("waiting");
    expect(VALID_TRANSITIONS.running).toContain("suspended");
    expect(VALID_TRANSITIONS.running).toContain("idle");
    expect(VALID_TRANSITIONS.running).toContain("terminated");
  });

  test("waiting can transition to running, suspended, and terminated", () => {
    expect(VALID_TRANSITIONS.waiting).toContain("running");
    expect(VALID_TRANSITIONS.waiting).toContain("suspended");
    expect(VALID_TRANSITIONS.waiting).toContain("terminated");
  });

  test("suspended can transition to running and terminated", () => {
    expect(VALID_TRANSITIONS.suspended).toContain("running");
    expect(VALID_TRANSITIONS.suspended).toContain("terminated");
  });

  test("idle can transition to running and terminated", () => {
    expect(VALID_TRANSITIONS.idle).toContain("running");
    expect(VALID_TRANSITIONS.idle).toContain("terminated");
  });

  test("terminated has no transitions", () => {
    expect(VALID_TRANSITIONS.terminated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_HEALTH_MONITOR_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_HEALTH_MONITOR_CONFIG backward compatibility", () => {
  test("all config keys present with expected values", () => {
    expect(DEFAULT_HEALTH_MONITOR_CONFIG.flushIntervalMs).toBe(30_000);
    expect(DEFAULT_HEALTH_MONITOR_CONFIG.sweepIntervalMs).toBe(10_000);
    expect(DEFAULT_HEALTH_MONITOR_CONFIG.suspectThresholdMs).toBe(60_000);
    expect(DEFAULT_HEALTH_MONITOR_CONFIG.deadThresholdMs).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SCHEDULER_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_SCHEDULER_CONFIG backward compatibility", () => {
  test("all config keys present with expected values", () => {
    expect(DEFAULT_SCHEDULER_CONFIG.maxConcurrent).toBe(10);
    expect(DEFAULT_SCHEDULER_CONFIG.defaultPriority).toBe(5);
    expect(DEFAULT_SCHEDULER_CONFIG.defaultMaxRetries).toBe(3);
    expect(DEFAULT_SCHEDULER_CONFIG.baseRetryDelayMs).toBe(1_000);
    expect(DEFAULT_SCHEDULER_CONFIG.maxRetryDelayMs).toBe(60_000);
    expect(DEFAULT_SCHEDULER_CONFIG.retryJitterMs).toBe(500);
    expect(DEFAULT_SCHEDULER_CONFIG.pollIntervalMs).toBe(1_000);
    expect(DEFAULT_SCHEDULER_CONFIG.staleTaskThresholdMs).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

describe("error factory backward compatibility", () => {
  test("notFound produces NOT_FOUND code", () => {
    const err = notFound("res-1");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("res-1");
  });

  test("conflict produces CONFLICT code", () => {
    const err = conflict("res-1");
    expect(err.code).toBe("CONFLICT");
    expect(err.retryable).toBe(true);
  });

  test("validation produces VALIDATION code", () => {
    const err = validation("bad input");
    expect(err.code).toBe("VALIDATION");
    expect(err.retryable).toBe(false);
  });

  test("internal produces INTERNAL code", () => {
    const err = internal("oops");
    expect(err.code).toBe("INTERNAL");
    expect(err.retryable).toBe(false);
  });

  test("rateLimit produces RATE_LIMIT code", () => {
    const err = rateLimit("slow down");
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  test("timeout produces TIMEOUT code", () => {
    const err = timeout("too slow");
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
  });

  test("timeout with retryAfterMs surfaces wait time", () => {
    const err = timeout("timed out", 2_000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2_000);
  });

  test("external produces EXTERNAL code", () => {
    const err = external("third-party down");
    expect(err.code).toBe("EXTERNAL");
    expect(err.retryable).toBe(false);
  });

  test("permission produces PERMISSION code", () => {
    const err = permission("denied");
    expect(err.code).toBe("PERMISSION");
    expect(err.retryable).toBe(false);
  });

  test("staleRef produces STALE_REF code", () => {
    const err = staleRef("e42");
    expect(err.code).toBe("STALE_REF");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("e42");
  });
});

// ---------------------------------------------------------------------------
// Well-known tokens
// ---------------------------------------------------------------------------

describe("well-known subsystem tokens backward compatibility", () => {
  test("all tokens are strings", () => {
    expect(typeof MEMORY).toBe("string");
    expect(typeof GOVERNANCE).toBe("string");
    expect(typeof CREDENTIALS).toBe("string");
    expect(typeof EVENTS).toBe("string");
    expect(typeof DELEGATION).toBe("string");
    expect(typeof FILESYSTEM).toBe("string");
    expect(typeof SCHEDULER).toBe("string");
    expect(typeof WEBHOOK).toBe("string");
  });

  test("token values match expected names", () => {
    expect(MEMORY as string).toBe("memory");
    expect(GOVERNANCE as string).toBe("governance");
    expect(CREDENTIALS as string).toBe("credentials");
    expect(EVENTS as string).toBe("events");
    expect(DELEGATION as string).toBe("delegation");
    expect(FILESYSTEM as string).toBe("filesystem");
    expect(SCHEDULER as string).toBe("scheduler");
    expect(WEBHOOK as string).toBe("webhook");
  });
});

// ---------------------------------------------------------------------------
// ID factories
// ---------------------------------------------------------------------------

describe("ID factory backward compatibility", () => {
  test("agentId returns branded string", () => {
    const id = agentId("a-1");
    expect(id as string).toBe("a-1");
  });

  test("sessionId returns branded string", () => {
    const id = sessionId("s-1");
    expect(id as string).toBe("s-1");
  });

  test("runId returns branded string", () => {
    const id = runId("r-1");
    expect(id as string).toBe("r-1");
  });

  test("turnId returns hierarchical branded string", () => {
    const rid = runId("r-1");
    const tid = turnId(rid, 0);
    expect(tid as string).toBe("r-1:t0");
  });

  test("toolCallId returns branded string", () => {
    const id = toolCallId("tc-1");
    expect(id as string).toBe("tc-1");
  });

  test("brickId returns branded string", () => {
    const id = brickId("b-1");
    expect(id as string).toBe("b-1");
  });

  test("snapshotId returns branded string", () => {
    const id = snapshotId("snap-1");
    expect(id as string).toBe("snap-1");
  });

  test("chainId returns branded string", () => {
    const id = chainId("c-1");
    expect(id as string).toBe("c-1");
  });

  test("nodeId returns branded string", () => {
    const id = nodeId("n-1");
    expect(id as string).toBe("n-1");
  });

  test("taskId returns branded string", () => {
    const id = taskId("t-1");
    expect(id as string).toBe("t-1");
  });

  test("scheduleId returns branded string", () => {
    const id = scheduleId("sch-1");
    expect(id as string).toBe("sch-1");
  });
});

// ---------------------------------------------------------------------------
// TransitionReason idle variants
// ---------------------------------------------------------------------------

describe("TransitionReason idle variants backward compatibility", () => {
  test("task_completed_idle maps to exit code 0", () => {
    expect(exitCodeForTransitionReason({ kind: "task_completed_idle" })).toBe(0);
  });

  test("inbox_wake maps to exit code 0", () => {
    expect(exitCodeForTransitionReason({ kind: "inbox_wake" })).toBe(0);
  });
});

describe("TaskableAgent backward compatibility", () => {
  test("TaskableAgent is constructible with only original 4 fields", () => {
    // This is the critical source-compat test: code that constructs TaskableAgent
    // with just the old shape must still compile and work.
    const taskable: TaskableAgent = {
      name: "test",
      description: "test agent",
      manifest: { name: "test", version: "1.0.0", model: { name: "test-model" } },
    };
    expect(taskable.name).toBe("test");
    expect(taskable.description).toBe("test agent");
    expect(taskable.manifest.name).toBe("test");
    expect(taskable.brickId).toBeUndefined();
  });

  test("AgentDefinition is assignable to TaskableAgent", () => {
    const def: AgentDefinition = {
      agentType: "researcher",
      whenToUse: "Research agent",
      source: "built-in",
      manifest: { name: "researcher", version: "1.0.0", model: { name: "sonnet" } },
      name: "researcher",
      description: "Research agent",
    };
    // AgentDefinition extends TaskableAgent — must be assignable
    const taskable: TaskableAgent = def;
    expect(taskable.name).toBe("researcher");
    expect(taskable.description).toBe("Research agent");
  });
});

describe("AGENT_DEFINITION_PRIORITY backward compatibility", () => {
  test("contains all three source tiers", () => {
    expect(AGENT_DEFINITION_PRIORITY["built-in"]).toBe(0);
    expect(AGENT_DEFINITION_PRIORITY.user).toBe(1);
    expect(AGENT_DEFINITION_PRIORITY.project).toBe(2);
  });
});
