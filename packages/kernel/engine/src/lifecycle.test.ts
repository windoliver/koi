import { describe, expect, test } from "bun:test";
import type { AgentLifecycle, LifecycleEvent, WaitReason } from "./lifecycle.js";
import { createLifecycle, transition } from "./lifecycle.js";

const NOW = 1000;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function created(): AgentLifecycle {
  return { state: "created", createdAt: NOW };
}

function running(): AgentLifecycle {
  return { state: "running", startedAt: NOW, turnIndex: 0 };
}

function waiting(reason: WaitReason = "model_call"): AgentLifecycle {
  return { state: "waiting", reason, since: NOW };
}

function suspended(): AgentLifecycle {
  return { state: "suspended", suspendedAt: NOW, reason: "budget exceeded" };
}

function terminated(): AgentLifecycle {
  return { state: "terminated", stopReason: "completed", terminatedAt: NOW };
}

const METRICS = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  turns: 5,
  durationMs: 1000,
} as const;

// ---------------------------------------------------------------------------
// createLifecycle
// ---------------------------------------------------------------------------

describe("createLifecycle", () => {
  test("starts in created state", () => {
    const lc = createLifecycle(NOW);
    expect(lc.state).toBe("created");
  });

  test("records createdAt timestamp", () => {
    const lc = createLifecycle(42);
    expect(lc.state === "created" && lc.createdAt).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Valid transitions (exhaustive)
// ---------------------------------------------------------------------------

describe("valid transitions", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly from: AgentLifecycle;
    readonly event: LifecycleEvent;
    readonly expectedState: AgentLifecycle["state"];
  }> = [
    // created →
    {
      name: "created → running (start)",
      from: created(),
      event: { kind: "start" },
      expectedState: "running",
    },
    {
      name: "created → terminated (error)",
      from: created(),
      event: { kind: "error", error: new Error("boom") },
      expectedState: "terminated",
    },

    // running →
    {
      name: "running → waiting (wait:model_call)",
      from: running(),
      event: { kind: "wait", reason: "model_call" },
      expectedState: "waiting",
    },
    {
      name: "running → waiting (wait:tool_call)",
      from: running(),
      event: { kind: "wait", reason: "tool_call" },
      expectedState: "waiting",
    },
    {
      name: "running → suspended (suspend)",
      from: running(),
      event: { kind: "suspend", reason: "budget" },
      expectedState: "suspended",
    },
    {
      name: "running → terminated (complete)",
      from: running(),
      event: { kind: "complete", stopReason: "completed" },
      expectedState: "terminated",
    },
    {
      name: "running → terminated (complete w/ metrics)",
      from: running(),
      event: { kind: "complete", stopReason: "completed", metrics: METRICS },
      expectedState: "terminated",
    },
    {
      name: "running → terminated (complete:max_turns)",
      from: running(),
      event: { kind: "complete", stopReason: "max_turns" },
      expectedState: "terminated",
    },
    {
      name: "running → terminated (error)",
      from: running(),
      event: { kind: "error", error: "fail" },
      expectedState: "terminated",
    },

    // waiting →
    {
      name: "waiting → running (resume)",
      from: waiting(),
      event: { kind: "resume" },
      expectedState: "running",
    },
    {
      name: "waiting → suspended (suspend)",
      from: waiting(),
      event: { kind: "suspend", reason: "pause" },
      expectedState: "suspended",
    },
    {
      name: "waiting → terminated (complete)",
      from: waiting(),
      event: { kind: "complete", stopReason: "completed" },
      expectedState: "terminated",
    },
    {
      name: "waiting → terminated (error)",
      from: waiting(),
      event: { kind: "error", error: null },
      expectedState: "terminated",
    },

    // suspended →
    {
      name: "suspended → running (resume)",
      from: suspended(),
      event: { kind: "resume" },
      expectedState: "running",
    },
    {
      name: "suspended → terminated (complete)",
      from: suspended(),
      event: { kind: "complete", stopReason: "interrupted" },
      expectedState: "terminated",
    },
    {
      name: "suspended → terminated (error)",
      from: suspended(),
      event: { kind: "error", error: undefined },
      expectedState: "terminated",
    },
  ];

  for (const { name, from, event, expectedState } of cases) {
    test(name, () => {
      const result = transition(from, event, NOW + 1);
      expect(result.state).toBe(expectedState);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid transitions (no-op — state stays the same)
// ---------------------------------------------------------------------------

describe("invalid transitions (no-op)", () => {
  const noOpCases: ReadonlyArray<{
    readonly name: string;
    readonly from: AgentLifecycle;
    readonly event: LifecycleEvent;
  }> = [
    // created — can't wait, resume, suspend, or complete
    { name: "created + wait", from: created(), event: { kind: "wait", reason: "model_call" } },
    { name: "created + resume", from: created(), event: { kind: "resume" } },
    { name: "created + suspend", from: created(), event: { kind: "suspend", reason: "x" } },
    {
      name: "created + complete",
      from: created(),
      event: { kind: "complete", stopReason: "completed" },
    },

    // running — can't start or resume
    { name: "running + start", from: running(), event: { kind: "start" } },
    { name: "running + resume", from: running(), event: { kind: "resume" } },

    // waiting — can't start or wait
    { name: "waiting + start", from: waiting(), event: { kind: "start" } },
    { name: "waiting + wait", from: waiting(), event: { kind: "wait", reason: "tool_call" } },

    // suspended — can't start, wait, or suspend
    { name: "suspended + start", from: suspended(), event: { kind: "start" } },
    { name: "suspended + wait", from: suspended(), event: { kind: "wait", reason: "model_call" } },
    { name: "suspended + suspend", from: suspended(), event: { kind: "suspend", reason: "again" } },
  ];

  for (const { name, from, event } of noOpCases) {
    test(`${name} → stays in ${from.state}`, () => {
      const result = transition(from, event, NOW + 1);
      expect(result).toBe(from); // Same reference — no new object created
    });
  }
});

// ---------------------------------------------------------------------------
// Terminated is absorbing
// ---------------------------------------------------------------------------

describe("terminated is absorbing", () => {
  const allEvents: readonly LifecycleEvent[] = [
    { kind: "start" },
    { kind: "wait", reason: "model_call" },
    { kind: "resume" },
    { kind: "suspend", reason: "test" },
    { kind: "complete", stopReason: "completed" },
    { kind: "error", error: new Error("test") },
  ];

  for (const event of allEvents) {
    test(`terminated + ${event.kind} → stays terminated`, () => {
      const term = terminated();
      const result = transition(term, event, NOW + 1);
      expect(result).toBe(term); // Same reference — no new object
      expect(result.state).toBe("terminated");
    });
  }
});

// ---------------------------------------------------------------------------
// State data correctness
// ---------------------------------------------------------------------------

describe("state data correctness", () => {
  test("running carries startedAt and turnIndex", () => {
    const result = transition(created(), { kind: "start" }, 2000);
    expect(result.state).toBe("running");
    if (result.state === "running") {
      expect(result.startedAt).toBe(2000);
      expect(result.turnIndex).toBe(0);
    }
  });

  test("waiting carries reason and since", () => {
    const result = transition(running(), { kind: "wait", reason: "tool_call" }, 3000);
    expect(result.state).toBe("waiting");
    if (result.state === "waiting") {
      expect(result.reason).toBe("tool_call");
      expect(result.since).toBe(3000);
    }
  });

  test("suspended carries suspendedAt and reason", () => {
    const result = transition(running(), { kind: "suspend", reason: "budget limit" }, 4000);
    expect(result.state).toBe("suspended");
    if (result.state === "suspended") {
      expect(result.suspendedAt).toBe(4000);
      expect(result.reason).toBe("budget limit");
    }
  });

  test("terminated carries stopReason and terminatedAt", () => {
    const result = transition(running(), { kind: "complete", stopReason: "max_turns" }, 5000);
    expect(result.state).toBe("terminated");
    if (result.state === "terminated") {
      expect(result.stopReason).toBe("max_turns");
      expect(result.terminatedAt).toBe(5000);
    }
  });

  test("terminated carries metrics when provided", () => {
    const result = transition(
      running(),
      { kind: "complete", stopReason: "completed", metrics: METRICS },
      6000,
    );
    if (result.state === "terminated") {
      expect(result.metrics).toEqual(METRICS);
    }
  });

  test("terminated has no metrics when not provided", () => {
    const result = transition(running(), { kind: "complete", stopReason: "completed" }, 7000);
    if (result.state === "terminated") {
      expect(result.metrics).toBeUndefined();
    }
  });

  test("error transition sets stopReason to error", () => {
    const result = transition(running(), { kind: "error", error: new Error("crash") }, 8000);
    if (result.state === "terminated") {
      expect(result.stopReason).toBe("error");
    }
  });
});

// ---------------------------------------------------------------------------
// Immutability invariant
// ---------------------------------------------------------------------------

describe("immutability", () => {
  test("transition returns new object (not same reference)", () => {
    const before = created();
    const after = transition(before, { kind: "start" }, NOW);
    expect(after).not.toBe(before);
    expect(before.state).toBe("created"); // Original unchanged
    expect(after.state).toBe("running");
  });

  test("no-op returns same reference", () => {
    const before = created();
    const after = transition(before, { kind: "resume" }, NOW);
    expect(after).toBe(before); // Same reference — no allocation
  });
});
