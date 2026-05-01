/**
 * Rule middleware behavior tests.
 *
 * Covers the skip-set lifecycle: windowed blocks must expire so that a
 * transient failure burst does not permanently disable a tool, and
 * unconditional skip rules still produce session-permanent blocks.
 */

import { describe, expect, test } from "bun:test";
import type { SessionContext, ToolHandler, ToolResponse, TurnContext } from "@koi/core";
import { sessionId } from "@koi/core";
import { createEventRulesMiddleware } from "./rule-middleware.js";
import { validateEventRulesConfig } from "./rule-schema.js";

function turnCtx(id: string, turnIndex = 0): TurnContext {
  return {
    session: { sessionId: sessionId(id), agentId: "a", metadata: {} },
    turnIndex,
    metadata: {},
  } as unknown as TurnContext;
}

function compile(rules: readonly Record<string, unknown>[]) {
  const result = validateEventRulesConfig({ rules });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const failing: ToolHandler = async () => ({ output: "boom", metadata: { error: true } });
const ok: ToolHandler = async () => ({ output: "ok" });

describe("createEventRulesMiddleware — skip lifecycle", () => {
  test("windowed skip expires after window elapses, allowing the tool again", async () => {
    const ruleset = compile([
      {
        name: "trip-on-failures",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    // let justified: simulated wall clock advanced across calls
    let nowMs = 1_000_000_000;
    const mw = createEventRulesMiddleware({ ruleset, now: () => nowMs });
    const ctx = turnCtx("sess-windowed");

    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    nowMs += 1_000;
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);

    // Within window — blocked
    nowMs += 30_000;
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);

    // Past expiry — block lifts
    nowMs += 60_001;
    const allowed = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(allowed.metadata?.blocked).toBeUndefined();
    expect(allowed.output).toBe("ok");
  });

  test("skip_tool from session_start rule blocks subsequent tool calls", async () => {
    const ruleset = compile([
      {
        name: "preban-shell",
        on: "session_start",
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-startban");
    await mw.onSessionStart?.(ctx.session);
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("skip_tool from turn_complete rule blocks subsequent tool calls", async () => {
    const ruleset = compile([
      {
        name: "ban-on-turn",
        on: "turn_complete",
        match: { turnIndex: { gte: 1 } },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-turnban", 1);
    await mw.onAfterTurn?.(ctx);
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("unconditional skip_tool rule on tool_call blocks the very first invocation", async () => {
    const ruleset = compile([
      {
        name: "ban-shell",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-precall");
    // let justified: track whether the inner handler ran
    let nextCalled = false;
    const sentinel: ToolHandler = async () => {
      nextCalled = true;
      return { output: "side-effect" };
    };

    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      sentinel,
    )) as ToolResponse;
    expect(nextCalled).toBe(false);
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("windowed skip_tool refreshes expiry on continued matches", async () => {
    const ruleset = compile([
      {
        name: "trip-on-failures",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    // let justified: simulated wall clock spanning multiple windows
    let nowMs = 1_000_000_000;
    const mw = createEventRulesMiddleware({ ruleset, now: () => nowMs });
    const ctx = turnCtx("sess-refresh");

    // Trip the rule (2 failures within window)
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);

    // 90s later — original block expired (window=60s) — but the failure
    // is still ongoing. With expiry refresh, the block must hold.
    nowMs += 30_000;
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    nowMs += 30_000;
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    nowMs += 30_000;
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("tool_call rule can match on agentId context field for log/notify (non-skip) actions", async () => {
    // skip_tool on agentId is rejected at validation (block widens
    // to all agents in shared session). Logging/alerting on agentId
    // is fine — those are observation-only.
    const ruleset = compile([
      {
        name: "scoped-log",
        on: "tool_call",
        match: { agentId: "agent-a", toolId: "shell_exec" },
        actions: [{ type: "log", level: "warn", message: "agent-a invoked {{toolId}}" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });

    const ctxA: TurnContext = {
      session: { sessionId: sessionId("s"), agentId: "agent-a", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;
    await mw.wrapToolCall?.(ctxA, { toolId: "shell_exec", input: {} }, ok);
    // Yield microtasks so the fire-and-forget log action executes.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(warnings).toContain("agent-a invoked shell_exec");

    const ctxB: TurnContext = {
      session: { sessionId: sessionId("s2"), agentId: "agent-b", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;
    warnings.length = 0;
    await mw.wrapToolCall?.(ctxB, { toolId: "shell_exec", input: {} }, ok);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(warnings).not.toContain("agent-a invoked shell_exec");
  });

  test("pre-call skip_tool blocks without exfiltrating raw tool input via companion actions", async () => {
    // Pre-call action execution is suppressed to prevent templated
    // messages from leaking unsanitized tool arguments before inner
    // permissions/hook layers run. Observability of the block is
    // preserved by the default denial log.
    const ruleset = compile([
      {
        name: "block-and-log",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [
          { type: "log", level: "warn", message: "would-leak {{secretArg}}" },
          { type: "skip_tool", toolId: "shell_exec" },
        ],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-precall-log");
    let nextCalled = false;
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: { secretArg: "P@ssw0rd!" } },
      async () => {
        nextCalled = true;
        return { output: "x" };
      },
    );
    expect(nextCalled).toBe(false);
    // Companion log MUST NOT have fired with raw input.
    expect(warnings.some((m) => m.includes("P@ssw0rd!"))).toBe(false);
    expect(warnings.some((m) => m.includes("would-leak"))).toBe(false);
    // Default denial log still emits so blocks remain observable.
    expect(warnings.some((m) => m.includes("event_rules_skip"))).toBe(true);
  });

  test("non-blocking unconditional rule fires log exactly once per call", async () => {
    const ruleset = compile([
      {
        name: "log-only",
        on: "tool_call",
        match: { toolId: "list_files" },
        actions: [{ type: "log", level: "info", message: "called {{toolId}}" }],
      },
    ]);
    const infos: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: (m: string) => infos.push(m),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-once");
    await mw.wrapToolCall?.(ctx, { toolId: "list_files", input: {} }, ok);
    expect(infos).toEqual(["called list_files"]);
  });

  test("half-open: blocked retries don't extend the window — block lifts after windowMs without real failures", async () => {
    const ruleset = compile([
      {
        name: "trip-on-failures",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    // let justified: simulated wall clock for deterministic expiry
    let nowMs = 1_000_000_000;
    const mw = createEventRulesMiddleware({ ruleset, now: () => nowMs });
    const ctx = turnCtx("sess-halfopen");

    // Trip the rule
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);

    // Spam blocked retries (no real executions) — must NOT extend window.
    // A self-sustaining outage purely from agent retries is a regression.
    for (let i = 0; i < 5; i++) {
      nowMs += 10_000;
      await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, ok);
    }

    // Past the original 60s window — block lifts, next call probes
    // recovery and (in this test) succeeds because the dependency healed.
    nowMs += 60_001;
    const probed = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(probed.metadata?.blocked).toBeUndefined();
    expect(probed.output).toBe("ok");
  });

  test("onBlock callback fires on event-rules denial so hosts can wire audit", async () => {
    const ruleset = compile([
      {
        name: "ban-shell",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const blockEvents: Array<{ toolId: string; reason: string }> = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        onBlock: ({ toolId, reason }) => {
          blockEvents.push({ toolId, reason });
        },
      },
    });
    const ctx = turnCtx("sess-onblock");
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, ok);
    expect(blockEvents).toEqual([{ toolId: "shell_exec", reason: "event_rules_skip" }]);
  });

  test("placed in intercept phase so it observes upstream blocked responses", () => {
    const ruleset = compile([
      { name: "r", on: "tool_call", actions: [{ type: "log", level: "info", message: "x" }] },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    expect(mw.phase).toBe("intercept");
    // Priority must be lower than peer intercept-phase enforcers
    // (permissions=100, call-limits=175) so this is the OUTERMOST wrapper
    // and blocks from those layers still flow back through this middleware.
    expect((mw.priority ?? 500) < 100).toBe(true);
  });

  test("intercept-phase outer wrap sees inner middleware's blocked response", async () => {
    const ruleset = compile([
      {
        name: "alert-on-failures",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "{{toolId}} failed" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-outer");
    // Simulate an inner middleware (permissions/call-limits) returning a
    // blocked response without throwing — exactly the case observe-phase
    // placement would have missed.
    const blockedByInnerMW: ToolHandler = async () => ({
      output: "blocked",
      metadata: { blocked: true, error: true, reason: "tool_call_limit_exceeded" },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, blockedByInnerMW);
    expect(warnings).toEqual(["shell_exec failed"]);
  });

  test("classifies hook-blocked response as failure (metadata.blockedByHook)", async () => {
    const ruleset = compile([
      {
        name: "alert-on-failures",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "{{toolId}} failed" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-hookblock");
    const hookBlocked: ToolHandler = async () => ({
      output: { error: "policy denied" },
      metadata: { blockedByHook: true },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, hookBlocked);
    expect(warnings).toEqual(["shell_exec failed"]);
  });

  test("classifies output `{ ok: false }` payload as failure", async () => {
    const ruleset = compile([
      {
        name: "alert-on-failures",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "fail" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-okfalse");
    const validationFail: ToolHandler = async () => ({
      output: { ok: false, error: "bad input" },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "task_update", input: {} }, validationFail);
    expect(warnings).toEqual(["fail"]);
  });

  test("strictActions throws when escalate handler is missing", () => {
    const ruleset = compile([
      {
        name: "needs-escalate",
        on: "tool_call",
        actions: [{ type: "escalate", message: "fail" }],
      },
    ]);
    expect(() => createEventRulesMiddleware({ ruleset, strictActions: true })).toThrow(
      /requestEscalation/,
    );
  });

  test("strictActions accepts ruleset when all required handlers are wired", () => {
    const ruleset = compile([
      {
        name: "needs-notify",
        on: "tool_call",
        actions: [{ type: "notify", channel: "ops", message: "hi" }],
      },
    ]);
    expect(() =>
      createEventRulesMiddleware({
        ruleset,
        strictActions: true,
        actionContext: { sendNotification: () => {} },
      }),
    ).not.toThrow();
  });

  test("strictActions ignores non-side-effecting actions (log, skip_tool)", () => {
    const ruleset = compile([
      {
        name: "log-and-skip",
        on: "tool_call",
        actions: [
          { type: "log", level: "warn", message: "x" },
          { type: "skip_tool", toolId: "shell_exec" },
        ],
      },
    ]);
    expect(() => createEventRulesMiddleware({ ruleset, strictActions: true })).not.toThrow();
  });

  test("default mode (strictActions=false) accepts missing handlers and degrades", async () => {
    const ruleset = compile([
      {
        name: "needs-escalate",
        on: "tool_call",
        actions: [{ type: "escalate", message: "fail" }],
      },
    ]);
    expect(() => createEventRulesMiddleware({ ruleset })).not.toThrow();
  });

  test("blocked tool calls always emit a default warn log so audit/trace pipelines see denials without onBlock wiring", async () => {
    const ruleset = compile([
      {
        name: "always-skip",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-default-denial-log");
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, ok);
    expect(warnings.some((m) => m.includes("blocked tool 'shell_exec'"))).toBe(true);
    expect(warnings.some((m) => m.includes("event_rules_skip"))).toBe(true);
  });

  test("post-call action templates do not interpolate raw tool input fields", async () => {
    // A rule that templates `{{password}}` MUST NOT render the secret
    // even though the predicate could legitimately match against it.
    // Action interpolation reads from the engine-built safe-context
    // allowlist, not the flat input fields.
    const ruleset = compile([
      {
        name: "log-on-fail",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "fail tool={{toolId}} pw={{password}}" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-postcall-render");
    await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: { password: "P@ssw0rd!" } },
      failing,
    );
    expect(warnings.some((m) => m.includes("P@ssw0rd!"))).toBe(false);
    expect(warnings.some((m) => m.includes("tool=shell_exec"))).toBe(true);
  });

  test("schema rejects narrower-than-toolId skip_tool rules to prevent session-wide bans", () => {
    // skip_tool blocks are stored by toolId only — no per-call predicate
    // re-evaluation. A rule like { match: { toolId: "shell_exec",
    // command: "rm -rf /" }, actions: [skip_tool] } would, after the
    // first hit, silently ban ALL later shell_exec calls regardless of
    // input. Validation rejects these so policy authors must use a
    // non-skip action (log/notify/escalate) for input-scoped denial.
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "deny-rm-rf",
          on: "tool_call",
          match: { toolId: "shell_exec", command: "rm -rf /" },
          actions: [{ type: "skip_tool", toolId: "shell_exec" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("skip_tool");
    }
  });

  test("rejects skip_tool rule whose action toolId is unreachable from match.toolId", () => {
    // `match: { ok: false }, actions: [skip_tool: "shell_exec"]` lets
    // an UNRELATED tool's failure (e.g. git_commit) quarantine
    // shell_exec — counters are partitioned by event toolId but the
    // emitted skip uses the action's literal toolId. Validation must
    // reject these so authors are forced to constrain match.toolId.
    const noToolId = validateEventRulesConfig({
      rules: [
        {
          name: "any-failure-bans-shell",
          on: "tool_call",
          match: { ok: false },
          condition: { count: 2, window: "1m" },
          actions: [{ type: "skip_tool", toolId: "shell_exec" }],
        },
      ],
    });
    expect(noToolId.ok).toBe(false);

    const mismatchedString = validateEventRulesConfig({
      rules: [
        {
          name: "wrong-toolid",
          on: "tool_call",
          match: { ok: false, toolId: "git_commit" },
          condition: { count: 2, window: "1m" },
          actions: [{ type: "skip_tool", toolId: "shell_exec" }],
        },
      ],
    });
    expect(mismatchedString.ok).toBe(false);

    const oneOfMissing = validateEventRulesConfig({
      rules: [
        {
          name: "oneof-missing",
          on: "tool_call",
          match: { ok: false, toolId: ["git_commit", "git_push"] },
          condition: { count: 2, window: "1m" },
          actions: [{ type: "skip_tool", toolId: "shell_exec" }],
        },
      ],
    });
    expect(oneOfMissing.ok).toBe(false);

    // Statically reachable: oneOf includes the action toolId.
    const oneOfIncluded = validateEventRulesConfig({
      rules: [
        {
          name: "oneof-includes",
          on: "tool_call",
          match: { ok: false, toolId: ["shell_exec", "bash"] },
          condition: { count: 2, window: "1m" },
          actions: [{ type: "skip_tool", toolId: "shell_exec" }],
        },
      ],
    });
    expect(oneOfIncluded.ok).toBe(true);
  });

  test("thrown tool failures fire rules using the documented denial-isolation matcher", async () => {
    // `match: { ok: false, blocked: false, blockedByHook: false }` is
    // the documented pattern for "real execution failures only".
    // Thrown tools must populate blocked/blockedByHook=false explicitly
    // so exact-match predicates distinguish them from `undefined`.
    const ruleset = compile([
      {
        name: "real-failures-only",
        on: "tool_call",
        match: { ok: false, blocked: false, blockedByHook: false },
        actions: [{ type: "log", level: "warn", message: "hard fail {{toolId}}" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-throws");
    const thrower: ToolHandler = async () => {
      throw new Error("boom");
    };
    expect(mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, thrower)).rejects.toThrow(
      "boom",
    );
    // let it settle so the catch-path event fires before assertions
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toContain("hard fail shell_exec");
  });

  test("onSessionStart clears any stale tombstone so reused session IDs are not silently bypassed", async () => {
    const ruleset = compile([
      {
        name: "alert-fail",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "{{toolId}} failed" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const sId = sessionId("sess-reused");
    const sessionCtx: SessionContext = {
      sessionId: sId,
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;
    const ctx: TurnContext = {
      session: { sessionId: sId, agentId: "a", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;

    // First session ends — tombstone is set.
    await mw.onSessionEnd?.(sessionCtx);
    // Re-start the session with the same ID.
    await mw.onSessionStart?.(sessionCtx);
    // A failing call must now fire the rule again — tombstone cleared.
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(warnings).toContain("shell_exec failed");
  });

  test("late tool completion racing onSessionEnd's drain does not enqueue post-shutdown actions", async () => {
    // The teardown sequence sets the closed-tombstone BEFORE awaiting
    // the pending-actions drain. Late completions during that drain
    // must short-circuit rather than enqueue NEW work into a closing
    // session — otherwise their actions would either fire after
    // shutdown or be dropped when state is deleted.
    const ruleset = compile([
      // session_end rule: runs sync during onSessionEnd, before
      // tombstone. Its notify is in pendingActions.
      {
        name: "alert-end",
        on: "session_end",
        actions: [{ type: "notify", channel: "ops", message: "ended" }],
      },
      // tool_call rule: would fire if the late completion's post-call
      // path bypassed the tombstone.
      {
        name: "alert-fail",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "post-shutdown {{toolId}}" }],
      },
    ]);
    const warnings: string[] = [];
    let releaseNotify: () => void = () => {};
    const notifyDone = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
        sendNotification: async () => {
          await notifyDone;
        },
      },
    });
    const sId = sessionId("sess-race");
    const ctx: TurnContext = {
      session: { sessionId: sId, agentId: "a", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;
    const sessionCtx: SessionContext = {
      sessionId: sId,
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;

    let releaseTool: (r: ToolResponse) => void = () => {};
    const slowTool: ToolHandler = () =>
      new Promise<ToolResponse>((resolve) => {
        releaseTool = resolve;
      });
    const inFlight = mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, slowTool);

    // Begin teardown — session_end fires + drain begins waiting on the
    // stalled notify.
    const endPromise = mw.onSessionEnd?.(sessionCtx);
    // Yield microtasks so onSessionEnd's evaluateAndExecute and the
    // closedSessions.add() complete before we resolve the tool.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Resolve tool with failure — would have matched the tool_call rule.
    releaseTool({ output: "boom", metadata: { error: true } });
    await inFlight;

    // Release the stalled notify so onSessionEnd can complete.
    releaseNotify();
    await endPromise;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(warnings).not.toContain("post-shutdown shell_exec");
  });

  test("reused session ID during onSessionEnd drain does not tear down the new session's state", async () => {
    // Race: host reuses a sessionId while the prior session's
    // onSessionEnd is still draining pending actions. Without a
    // generation guard, the late teardown deletes the new session's
    // engine/skipSet/pendingActions — silently disabling rule
    // enforcement on the live session. The fix: generation token
    // bumped on every onSessionStart; onSessionEnd skips state
    // deletion when generation has advanced during the drain.
    const ruleset = compile([
      {
        name: "alert-end",
        on: "session_end",
        actions: [{ type: "notify", channel: "ops", message: "ended" }],
      },
      {
        name: "ban-tool",
        on: "session_start",
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    let releaseNotify: () => void = () => {};
    const notifyDone = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        sendNotification: async () => {
          await notifyDone;
        },
      },
    });
    const sId = sessionId("sess-reused");
    const sessionCtx: SessionContext = {
      sessionId: sId,
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;
    const turn: TurnContext = {
      session: { sessionId: sId, agentId: "a", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;

    // Open + start tearing down the original session.
    await mw.onSessionStart?.(sessionCtx);
    const endPromise = mw.onSessionEnd?.(sessionCtx);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Host reuses the sessionId mid-drain.
    await mw.onSessionStart?.(sessionCtx);

    // New session should now have skip_tool installed by ban-tool.
    // Let the original drain finish — it MUST NOT tear down the new
    // session's engine/skipSet.
    releaseNotify();
    await endPromise;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Probe: the new session's skip_tool block should still be active.
    const ok: ToolHandler = async () => ({ output: "ok" });
    const response = (await mw.wrapToolCall?.(
      turn,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(response.metadata?.blocked).toBe(true);
    expect(response.metadata?.reason).toBe("event_rules_skip");
  });

  test("late tool completion after onSessionEnd does not resurrect engine state or fire rules", async () => {
    const ruleset = compile([
      {
        name: "alert-on-fail",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "post-teardown {{toolId}}" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const sId = sessionId("sess-late");
    const ctx: TurnContext = {
      session: { sessionId: sId, agentId: "a", metadata: {} },
      turnIndex: 0,
      metadata: {},
    } as unknown as TurnContext;
    const sessionCtx: SessionContext = {
      sessionId: sId,
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;

    // Start a tool call that resolves on a manual gate, simulating
    // an inner middleware that hangs past session teardown.
    let releaseTool: (r: ToolResponse) => void = () => {};
    const slowTool: ToolHandler = () =>
      new Promise<ToolResponse>((resolve) => {
        releaseTool = resolve;
      });
    const inFlight = mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, slowTool);

    // Tear the session down while the call is still pending.
    await mw.onSessionEnd?.(sessionCtx);

    // Now resolve the tool with a failure — would have matched the rule.
    releaseTool({ output: "boom", metadata: { error: true } });
    await inFlight;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(warnings).not.toContain("post-teardown shell_exec");

    // Subsequent calls into this session also bypass rule logic.
    const after = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(after.output).toBe("ok");
  });

  test("ordinary {error,code} tool errors are not misclassified as exfiltration denials", async () => {
    // Tools like `memory_recall` legitimately return `{ error,
    // code: "VALIDATION" }` on bad input. Those are real execution
    // failures and the documented circuit-breaker matcher MUST fire
    // on them — exfil-guard recognition is keyed on the literal
    // "Exfiltration guard:" prefix, not the generic shape.
    const ruleset = compile([
      {
        name: "real-failures-only",
        on: "tool_call",
        match: { ok: false, blocked: false, blockedByHook: false, toolId: "memory_recall" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "memory_recall" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-validation-err");
    const validationErr: ToolHandler = async () => ({
      output: { error: "max_hops must be a non-negative integer", code: "VALIDATION" },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "memory_recall", input: {} }, validationErr);
    await mw.wrapToolCall?.(ctx, { toolId: "memory_recall", input: {} }, validationErr);
    // Threshold (2) tripped — third call must be blocked.
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "memory_recall", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("onSessionEnd drains pending notify/emit/escalate before resetting state", async () => {
    const ruleset = compile([
      {
        name: "alert-on-end",
        on: "session_end",
        actions: [{ type: "notify", channel: "ops", message: "ended" }],
      },
    ]);
    let resolveNotify: () => void = () => {};
    let notifyDelivered = false;
    const notifyPromise = new Promise<void>((resolve) => {
      resolveNotify = () => {
        notifyDelivered = true;
        resolve();
      };
    });
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        sendNotification: async () => {
          // Schedule resolution on next microtask so onSessionEnd's
          // drain has a pending promise to await — modeling a real
          // backend that takes some time to return.
          await Promise.resolve();
          resolveNotify();
          await notifyPromise;
        },
      },
    });
    const sessionCtx: SessionContext = {
      sessionId: sessionId("sess-drain"),
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;
    await mw.onSessionEnd?.(sessionCtx);
    expect(notifyDelivered).toBe(true);
  });

  test("onSessionEnd drain is bounded — a hung action handler does not block teardown forever", async () => {
    // Each pending action is internally bounded by runBounded's 5s
    // timeout. onSessionEnd's drain awaits Promise.allSettled on the
    // bounded promises, so even a notify backend that NEVER resolves
    // must let teardown complete (within the 5s ceiling) and delete
    // engine/skipSet/pendingActions for the session. Without this
    // bound, one hung alerting backend would wedge every session
    // shutdown indefinitely.
    const ruleset = compile([
      {
        name: "alert-end",
        on: "session_end",
        actions: [{ type: "notify", channel: "ops", message: "ended" }],
      },
    ]);
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        // Resolves never — the bounded timeout must rescue us.
        sendNotification: () => new Promise<void>(() => {}),
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
    });
    const sessionCtx: SessionContext = {
      sessionId: sessionId("sess-hung"),
      agentId: "a",
      metadata: {},
    } as unknown as SessionContext;
    const start = Date.now();
    await mw.onSessionEnd?.(sessionCtx);
    const elapsed = Date.now() - start;
    // Must complete within the 5s bound (give 1s slack for CI noise).
    expect(elapsed).toBeLessThan(6_000);
  }, 10_000);

  test("exfiltration-guard denials don't trip 'real failures only' circuit breakers", async () => {
    // The documented denial-isolation matcher must exclude exfil-
    // guard blocks too — they're policy denials, not execution
    // failures, and should not let malicious input quarantine a
    // healthy tool.
    const ruleset = compile([
      {
        name: "real-failures-only",
        on: "tool_call",
        match: { ok: false, blocked: false, blockedByHook: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-exfil-isolation");
    const exfilDeny: ToolHandler = async () => ({
      output: {
        error: "Exfiltration guard: 1 secret(s) detected — blocked",
        code: "PERMISSION",
      },
    });
    // 5 exfil denials must NOT trip the threshold.
    for (let i = 0; i < 5; i++) {
      await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, exfilDeny);
    }
    const stillAllowed = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(stillAllowed.metadata?.blocked).toBeUndefined();
    expect(stillAllowed.output).toBe("ok");
  });

  test("exfiltration-guard deny shape (output.error+code, no metadata) is classified as failure", async () => {
    const ruleset = compile([
      {
        name: "alert-on-failures",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "{{toolId}} failed" }],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-exfil");
    const exfilDeny: ToolHandler = async () => ({
      output: {
        error: "Exfiltration guard: 1 secret(s) detected in tool input — request blocked",
        code: "PERMISSION",
      },
    });
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, exfilDeny);
    expect(warnings).toEqual(["shell_exec failed"]);
  });

  test("deny path does not stall on a slow onBlock callback (bounded by timeout)", async () => {
    // A slow audit/paging hook on onBlock previously could stall every
    // blocked retry. The deny path now bounds onBlock to the auxiliary
    // handler timeout (5s) and aborts via AbortSignal on timeout.
    // We verify the test completes in a bounded time well below the
    // tool-call default with a never-resolving onBlock that respects
    // AbortSignal — any host that doesn't honor the signal at least
    // can't outlast the timeout.
    const ruleset = compile([
      {
        name: "always-skip",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    let onBlockCalled = false;
    let abortFired = false;
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        onBlock: (_info, signal) =>
          new Promise<void>((resolve) => {
            onBlockCalled = true;
            // AbortSignal-aware handler: resolves on abort so we don't
            // hit the 5s timeout in the test suite. The real point of
            // this test is that the deny path RETURNS the canonical
            // block synchronously after onBlock either resolves or
            // signals abort — no host code can hang it indefinitely.
            signal?.addEventListener("abort", () => {
              abortFired = true;
              resolve();
            });
            // Force timeout by never resolving on our own.
          }),
      },
    });
    const ctx = turnCtx("sess-onblock-bounded");
    // Use the engine's `now` to compress the timeout for the test —
    // we can't easily inject a fake timer, so just verify the call
    // returns the canonical block when onBlock honors abort.
    void abortFired;
    void onBlockCalled;
    // Manual fast-path: schedule abort by abandoning the await within
    // a Promise.race. We instead just assert the contract by using
    // an onBlock that resolves quickly via signal — which the
    // production runBounded triggers on its 5s timeout.
    const response = (await Promise.race([
      mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, ok),
      // safety net: this test should never be the slowest case.
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6_500)),
    ])) as ToolResponse | undefined;
    expect(response).toBeDefined();
    expect(response?.metadata?.blocked).toBe(true);
  }, 8_000);

  test("threshold-triggered block is installed before slow notify/escalate handlers complete", async () => {
    // skip_tool directives must commit synchronously so concurrent or
    // immediately-following calls see the block, even if the rule's
    // notify/escalate handler stalls on a degraded alerting backend.
    const ruleset = compile([
      {
        name: "burst-then-block",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [
          { type: "notify", channel: "ops", message: "tripped" },
          { type: "skip_tool", toolId: "shell_exec" },
        ],
      },
    ]);
    let releaseNotify: () => void = () => {};
    const notifyStarted = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    const slowNotifyDone = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    void notifyStarted;
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        sendNotification: async () => {
          // Stall like a hung alerting backend would.
          await slowNotifyDone;
        },
      },
    });
    const ctx = turnCtx("sess-sync-block");
    // Two failing calls trip the threshold.
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    // Second failing call kicks off a stalled notify handler. Don't await.
    const secondCall = mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    // Yield enough microtasks for the second call to run through its
    // tool handler and reach `evaluateAndExecute` (which installs the
    // skip synchronously before awaiting the stalled notify).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // While notify is still stalled, a third call must already see the block.
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
    // Release the stalled notify so the second call can complete.
    releaseNotify();
    await secondCall;
  });

  test("deny path returns canonical block even when logger and onBlock throw", async () => {
    const ruleset = compile([
      {
        name: "always-skip",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: () => {
            throw new Error("logger boom");
          },
          error: () => {},
          debug: () => {},
        },
        onBlock: () => {
          throw new Error("onBlock boom");
        },
      },
    });
    const ctx = turnCtx("sess-deny-throws");
    const response = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(response.metadata?.blocked).toBe(true);
    expect(response.metadata?.reason).toBe("event_rules_skip");
  });

  test("denial response sets blockedByHook so semantic-retry/event-trace classify it", async () => {
    const ruleset = compile([
      {
        name: "always-skip",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-denial-shape");
    const response = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(response.metadata?.blocked).toBe(true);
    expect(response.metadata?.blockedByHook).toBe(true);
    expect(response.metadata?.reason).toBe("event_rules_skip");
  });

  test("policy denials are distinguishable from execution failures via blocked/blockedByHook fields", async () => {
    // A circuit-breaker rule that wants to ignore policy denials should be
    // able to match `{ ok: false, blocked: false, blockedByHook: false }`
    // so repeated permission/hook denials don't trip skip_tool against a
    // healthy tool.
    const ruleset = compile([
      {
        name: "real-failures-only",
        on: "tool_call",
        match: { ok: false, blocked: false, blockedByHook: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    const mw = createEventRulesMiddleware({ ruleset });
    const ctx = turnCtx("sess-denial-isolation");

    const permissionDenied: ToolHandler = async () => ({
      output: "denied",
      metadata: { blocked: true, error: true, reason: "permission_denied" },
    });
    const hookVetoed: ToolHandler = async () => ({
      output: "vetoed",
      metadata: { blockedByHook: true },
    });

    // 5 policy denials should NOT trip the threshold.
    for (let i = 0; i < 3; i++) {
      await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, permissionDenied);
      await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, hookVetoed);
    }
    const stillAllowed = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(stillAllowed.metadata?.blocked).toBeUndefined();
    expect(stillAllowed.output).toBe("ok");

    // 2 real failures DO trip it.
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });

  test("threshold actions interpolate {{count}} and {{window}} from rule metadata", async () => {
    const ruleset = compile([
      {
        name: "burst-alert",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 3, window: "1m" },
        actions: [
          {
            type: "log",
            level: "warn",
            message: "Tool {{toolId}} failed {{count}} times in {{window}}",
          },
        ],
      },
    ]);
    const warnings: string[] = [];
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext: {
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
          error: () => {},
          debug: () => {},
        },
      },
    });
    const ctx = turnCtx("sess-template");
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, failing);
    expect(warnings).toEqual(["Tool shell_exec failed 3 times in 1m"]);
  });

  test("unconditional skip rule produces a permanent session-level block", async () => {
    const ruleset = compile([
      {
        name: "always-skip",
        on: "tool_call",
        match: { toolId: "shell_exec" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);
    // let justified: simulated wall clock to confirm permanence vs. expiry
    let nowMs = 1_000_000_000;
    const mw = createEventRulesMiddleware({ ruleset, now: () => nowMs });
    const ctx = turnCtx("sess-permanent");

    await mw.wrapToolCall?.(ctx, { toolId: "shell_exec", input: {} }, ok);
    // Far in the future — still blocked
    nowMs += 24 * 60 * 60 * 1000;
    const blocked = (await mw.wrapToolCall?.(
      ctx,
      { toolId: "shell_exec", input: {} },
      ok,
    )) as ToolResponse;
    expect(blocked.metadata?.blocked).toBe(true);
  });
});
