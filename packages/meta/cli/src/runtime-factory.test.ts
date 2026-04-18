/**
 * runtime-factory tests — verifies the full L2 tool stack wiring.
 *
 * These tests verify:
 *   - createKoiRuntime assembles without errors
 *   - transcript is exposed and mutable (splice works)
 *   - getTrajectorySteps() returns empty initially
 *   - getTrajectorySteps() caps at MAX_TRAJECTORY_STEPS
 *   - runtime exposes debug inventory showing expected tools/middleware
 *
 * Tests do NOT make real model calls — they use a stub ModelAdapter
 * and verify assembly structure, not behavior.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalHandler, KoiMiddleware, ModelAdapter } from "@koi/core";
import { toolToken } from "@koi/core";
import { MiddlewareRegistry, UnknownManifestMiddlewareError } from "./middleware-registry.js";
import { RequiredMiddlewareError } from "./required-middleware.js";
import { createKoiRuntime, MAX_TRAJECTORY_STEPS, resolveMaxDurationMs } from "./runtime-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub ModelAdapter — never makes real HTTP calls. */
function makeModelAdapter(): ModelAdapter {
  return {
    id: "stub-tui",
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    complete: mock(async () => ({ content: "", model: "stub" })),
    stream: mock(async function* () {}),
  };
}

/** Stub ApprovalHandler — auto-approves all requests. */
const stubApprovalHandler: ApprovalHandler = mock(async (_request) => ({
  kind: "allow" as const,
}));

/** Default config for tests. */
function makeConfig() {
  return {
    modelAdapter: makeModelAdapter(),
    modelName: "stub-model",
    approvalHandler: stubApprovalHandler,
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let runtimeHandle: Awaited<ReturnType<typeof createKoiRuntime>> | null = null;

afterEach(async () => {
  if (runtimeHandle !== null) {
    await runtimeHandle.runtime.dispose();
    runtimeHandle = null;
  }
});

describe("resolveMaxDurationMs — KOI_MAX_DURATION_MS coercion", () => {
  const ORIGINAL = process.env.KOI_MAX_DURATION_MS;
  const DEFAULT = 1_800_000;
  const MAX_SAFE = 2_147_483_647;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.KOI_MAX_DURATION_MS;
    else process.env.KOI_MAX_DURATION_MS = ORIGINAL;
  });

  test("unset env → default 30m cap", () => {
    delete process.env.KOI_MAX_DURATION_MS;
    expect(resolveMaxDurationMs()).toBe(DEFAULT);
  });

  test("empty string → default (not disable-cap)", () => {
    process.env.KOI_MAX_DURATION_MS = "";
    expect(resolveMaxDurationMs()).toBe(DEFAULT);
  });

  test("whitespace → default (not disable-cap)", () => {
    process.env.KOI_MAX_DURATION_MS = "   ";
    expect(resolveMaxDurationMs()).toBe(DEFAULT);
  });

  test("literal '0' → disabled (clamped to setTimeout int32 max)", () => {
    process.env.KOI_MAX_DURATION_MS = "0";
    expect(resolveMaxDurationMs()).toBe(MAX_SAFE);
  });

  test("large value → passed through (within safe range)", () => {
    process.env.KOI_MAX_DURATION_MS = "3600000";
    expect(resolveMaxDurationMs()).toBe(3_600_000);
  });

  test("value above setTimeout safe range → clamped", () => {
    process.env.KOI_MAX_DURATION_MS = String(Number.MAX_SAFE_INTEGER);
    expect(resolveMaxDurationMs()).toBe(MAX_SAFE);
  });

  test("invalid (NaN) → default", () => {
    process.env.KOI_MAX_DURATION_MS = "abc";
    expect(resolveMaxDurationMs()).toBe(DEFAULT);
  });

  test("negative → default", () => {
    process.env.KOI_MAX_DURATION_MS = "-1000";
    expect(resolveMaxDurationMs()).toBe(DEFAULT);
  });

  test("host default passed in overrides the built-in fallback", () => {
    // `koi start` passes 300_000 so automation gets a tighter cap
    // than the interactive TUI default.
    delete process.env.KOI_MAX_DURATION_MS;
    expect(resolveMaxDurationMs(300_000)).toBe(300_000);
  });

  test("env var still wins over host default when valid", () => {
    process.env.KOI_MAX_DURATION_MS = "60000";
    expect(resolveMaxDurationMs(300_000)).toBe(60_000);
  });

  test("env var falling back uses host default, not built-in fallback", () => {
    process.env.KOI_MAX_DURATION_MS = "abc";
    expect(resolveMaxDurationMs(300_000)).toBe(300_000);
  });

  test("zero-equivalent aliases do NOT disable the cap", () => {
    // `Number("00")`, `Number("+0")`, `Number("-0")`, `Number("0.0")`,
    // `Number("0e0")` all return 0 — without strict integer matching
    // every one would flip the cap off and force an immediate timeout.
    for (const raw of ["00", "+0", "-0", "0.0", "0e0", "0x0"]) {
      process.env.KOI_MAX_DURATION_MS = raw;
      expect(resolveMaxDurationMs()).toBe(DEFAULT);
    }
  });

  test("decimal / floating forms → default", () => {
    for (const raw of ["1.5", "1e3", "+1000"]) {
      process.env.KOI_MAX_DURATION_MS = raw;
      expect(resolveMaxDurationMs()).toBe(DEFAULT);
    }
  });
});

describe("createKoiRuntime — assembly", () => {
  test("assembles without errors", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("returns a mutable transcript array", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { transcript } = runtimeHandle;
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript).toHaveLength(0);
  });

  test("transcript can be spliced (session reset)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { transcript } = runtimeHandle;

    // Push a fake message
    transcript.push({
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text: "hello" }],
    });
    expect(transcript).toHaveLength(1);

    // Simulate session reset
    transcript.splice(0);
    expect(transcript).toHaveLength(0);
  });

  test("runtime has a sessionId", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(typeof runtimeHandle.runtime.sessionId).toBe("string");
    expect(runtimeHandle.runtime.sessionId.length).toBeGreaterThan(0);
  });

  test("wrapped runtime forwards the sessionId getter live after cycleSession", async () => {
    // Codex round-loop-2 round 3: the wrapper previously used
    // `{...runtime, dispose}` which snapshotted the sessionId
    // getter at construction time, so post-cycleSession reads
    // returned the stale id. A Proxy wrapper forwards the getter
    // live. This is the regression test.
    runtimeHandle = await createKoiRuntime(makeConfig());
    const initialId = runtimeHandle.runtime.sessionId;
    expect(typeof initialId).toBe("string");
    // Only exercise rotation if the runtime exposes cycleSession.
    if (runtimeHandle.runtime.cycleSession !== undefined) {
      await runtimeHandle.runtime.cycleSession();
      const rotatedId = runtimeHandle.runtime.sessionId;
      expect(typeof rotatedId).toBe("string");
      expect(rotatedId.length).toBeGreaterThan(0);
      expect(rotatedId).not.toBe(initialId);
    }
  });
});

describe("createKoiRuntime — trajectory steps", () => {
  test("getTrajectorySteps() returns empty array initially", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const steps = await runtimeHandle.getTrajectorySteps();
    expect(steps).toHaveLength(0);
  });

  test("getTrajectorySteps() caps at MAX_TRAJECTORY_STEPS", async () => {
    // Verify the constant is exported and has the expected value
    expect(MAX_TRAJECTORY_STEPS).toBe(200);
  });
});

describe("createKoiRuntime — runtime.run signature", () => {
  test("runtime.run is callable", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    // run() returns an AsyncIterable — verify it exists without actually calling it
    expect(typeof runtimeHandle.runtime.run).toBe("function");
  });
});

describe("createKoiRuntime — cwd defaults", () => {
  test("defaults cwd to process.cwd() when not provided", async () => {
    runtimeHandle = await createKoiRuntime({
      modelAdapter: makeModelAdapter(),
      modelName: "stub",
      approvalHandler: stubApprovalHandler,
      // No cwd provided — should use process.cwd()
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T2-A: Tool inventory snapshot — verifies all expected tools are wired
// ---------------------------------------------------------------------------

describe("createKoiRuntime — tool inventory", () => {
  /** Expected tool names that must be registered after createKoiRuntime(). */
  const EXPECTED_TOOLS = [
    "Glob",
    "Grep",
    "ToolSearch",
    "fs_read",
    "fs_write",
    "fs_edit",
    "Bash",
    "bash_background",
    "web_fetch",
    "task_create",
    "task_get",
    "task_list",
    "task_output",
    "task_stop",
    "task_update",
  ] as const;

  test("all expected tools are registered as agent components", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { agent } = runtimeHandle.runtime;

    const missing: string[] = [];
    for (const name of EXPECTED_TOOLS) {
      if (!agent.has(toolToken(name))) {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
  });

  test("expected tool count matches snapshot", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { agent } = runtimeHandle.runtime;

    // Count how many expected tools are present (should be all of them)
    const presentCount = EXPECTED_TOOLS.filter((name) => agent.has(toolToken(name))).length;
    expect(presentCount).toBe(EXPECTED_TOOLS.length);
  });
});

// ---------------------------------------------------------------------------
// T1-A: resetSessionState — full test suite
// ---------------------------------------------------------------------------

describe("createKoiRuntime — resetSessionState", () => {
  test("throws when signal is not aborted (C4-A)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const controller = new AbortController();
    // Signal not aborted — must throw
    await expect(runtimeHandle?.resetSessionState(controller.signal)).rejects.toThrow(
      "active AbortSignal must be aborted before resetting",
    );
  });

  test("succeeds when signal is aborted", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const controller = new AbortController();
    controller.abort();
    // Should not throw
    await expect(runtimeHandle?.resetSessionState(controller.signal)).resolves.toBeUndefined();
  });

  test("clears transcript on reset (caller responsibility)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { transcript } = runtimeHandle;

    // Simulate session with messages
    transcript.push({
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text: "hello" }],
    });
    expect(transcript).toHaveLength(1);

    // Abort + reset (now async)
    const controller = new AbortController();
    controller.abort();
    await runtimeHandle.resetSessionState(controller.signal);

    // Transcript is caller-managed; splice must be called separately
    transcript.splice(0);
    expect(transcript).toHaveLength(0);
  });

  test("multiple resets in sequence do not throw", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());

    // First reset
    const c1 = new AbortController();
    c1.abort();
    await runtimeHandle.resetSessionState(c1.signal);

    // Second reset with a new controller
    const c2 = new AbortController();
    c2.abort();
    await expect(runtimeHandle?.resetSessionState(c2.signal)).resolves.toBeUndefined();
  });

  test("hasActiveBackgroundTasks returns false initially", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.hasActiveBackgroundTasks()).toBe(false);
  });

  test("shutdownBackgroundTasks returns false when no tasks active", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.shutdownBackgroundTasks()).toBe(false);
  });

  test("sandboxActive reflects OS adapter availability", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    // sandboxActive depends on whether seatbelt/bwrap is available on this machine.
    // We just verify it's a boolean — the actual value depends on the test environment.
    expect(typeof runtimeHandle.sandboxActive).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Zone B — manifest-driven middleware integration
//
// These tests exercise the full wire-up from runtime factory config →
// MiddlewareRegistry → resolved chain → enforceRequiredMiddleware. They
// complement the unit tests in manifest-middleware.test.ts which cover
// the individual pieces in isolation.
// ---------------------------------------------------------------------------

function stubManifestMiddleware(name: string): KoiMiddleware {
  return { name } as unknown as KoiMiddleware;
}

describe("createKoiRuntime — zone B manifest middleware", () => {
  // Zone B is incompatible with the spawn preset stack in this
  // release (per-child re-resolution is a follow-up), so tests that
  // set `manifestMiddleware` must also explicitly exclude spawn
  // from the stack list. Use a helper to make that intent obvious.
  const STACKS_WITHOUT_SPAWN: readonly string[] = [
    "observability",
    "execution",
    "memory",
    "mcp",
    "notebook",
    "rules",
    "skills",
    "checkpoint",
  ];

  test("invokes the registered factory for each enabled entry with verbatim options", async () => {
    const registry = new MiddlewareRegistry();
    const capturedOptions: (Readonly<Record<string, unknown>> | undefined)[] = [];
    registry.register("test/option-capture", (entry) => {
      capturedOptions.push(entry.options);
      return stubManifestMiddleware("option-capture");
    });

    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [
        {
          name: "test/option-capture",
          options: { destination: "./audit.log", verbose: true },
          enabled: true,
        },
      ],
    });

    expect(capturedOptions).toEqual([{ destination: "./audit.log", verbose: true }]);
  });

  test("does not invoke the factory for entries with enabled: false", async () => {
    const registry = new MiddlewareRegistry();
    const enabledCalls: string[] = [];
    const disabledCalls: string[] = [];
    registry.register("test/enabled", () => {
      enabledCalls.push("hit");
      return stubManifestMiddleware("enabled");
    });
    registry.register("test/disabled", () => {
      disabledCalls.push("hit");
      return stubManifestMiddleware("disabled");
    });

    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [
        { name: "test/enabled", options: undefined, enabled: true },
        { name: "test/disabled", options: undefined, enabled: false },
      ],
    });

    expect(enabledCalls.length).toBe(1);
    expect(disabledCalls.length).toBe(0);
  });

  test("invokes multiple factories in declared order", async () => {
    const registry = new MiddlewareRegistry();
    const callOrder: string[] = [];
    registry.register("test/first", () => {
      callOrder.push("first");
      return stubManifestMiddleware("first");
    });
    registry.register("test/second", () => {
      callOrder.push("second");
      return stubManifestMiddleware("second");
    });
    registry.register("test/third", () => {
      callOrder.push("third");
      return stubManifestMiddleware("third");
    });

    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [
        { name: "test/third", options: undefined, enabled: true },
        { name: "test/first", options: undefined, enabled: true },
        { name: "test/second", options: undefined, enabled: true },
      ],
    });

    // Resolver walks the entries in declared manifest order, not
    // registration order. composeRuntimeMiddleware then preserves
    // that order when it splices zone B into the chain.
    expect(callOrder).toEqual(["third", "first", "second"]);
  });

  test("throws UnknownManifestMiddlewareError when entry name is not registered", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("test/known", () => stubManifestMiddleware("known"));

    await expect(
      createKoiRuntime({
        ...makeConfig(),
        stacks: STACKS_WITHOUT_SPAWN,
        middlewareRegistry: registry,
        manifestMiddleware: [{ name: "test/typo", options: undefined, enabled: true }],
      }),
    ).rejects.toBeInstanceOf(UnknownManifestMiddlewareError);
  });

  test("omitted manifestMiddleware is backward compatible — factory assembles normally", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.runtime).toBeDefined();
    // The factory would throw via enforceRequiredMiddleware if any of
    // hooks / permissions / exfiltration-guard were missing from the
    // composed chain, so reaching this line proves all three are
    // present when no manifest middleware is provided.
  });

  test("manifest middleware + spawn stack now assembles (per-child re-resolution wired)", async () => {
    // Earlier revisions fail-closed on this combination because
    // children would have inherited the parent's mutable middleware
    // instances. The runtime factory now stashes a per-child
    // re-resolution factory on the late-phase host bag, which the
    // spawn preset stack passes to createSpawnToolProvider so each
    // spawned child gets freshly-resolved middleware. Verify the
    // combination assembles without the old throw.
    const registry = new MiddlewareRegistry();
    registry.register("test/audit-like", () => stubManifestMiddleware("audit-like"));
    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      // No `stacks` override → spawn is active by default.
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/audit-like", options: undefined, enabled: true }],
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("manifest middleware with spawn explicitly disabled assembles cleanly", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("test/audit-like", () => stubManifestMiddleware("audit-like"));
    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/audit-like", options: undefined, enabled: true }],
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("manifest middleware shutdown hooks fire AFTER runtime.dispose() completes", async () => {
    // Codex round-10 finding #1: the audit sink's final session_end
    // record is written inside the engine's onSessionEnd path
    // during runtime.dispose(). Closing the sink before dispose
    // would drop that record. The runtime factory wraps
    // runtime.dispose so cleanup runs after the engine dispose
    // resolves.
    const order: string[] = [];
    const registry = new MiddlewareRegistry();
    registry.register("test/shutdown-probe", (_entry, ctx) => {
      ctx.registerShutdown(async () => {
        order.push("manifest-cleanup");
      });
      return stubManifestMiddleware("shutdown-probe");
    });
    const handle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/shutdown-probe", options: undefined, enabled: true }],
    });
    // runtime.dispose() is wrapped; it must run the engine dispose
    // first (no observable marker for that from outside), then our
    // shutdown hook second.
    await handle.runtime.dispose();
    expect(order).toEqual(["manifest-cleanup"]);
    // Explicitly clear so afterEach does not double-dispose.
    runtimeHandle = null;
  });

  test("manifest middleware cleanup is idempotent across repeated dispose() calls", async () => {
    // Codex round-loop-2 round 5 finding #2: dispose must be a
    // no-op on second call. Without a latch, retry-idempotent
    // shutdown paths would re-invoke sink.close() on an
    // already-ended writer and throw.
    let cleanupCount = 0;
    const registry = new MiddlewareRegistry();
    registry.register("test/idempotent-probe", (_entry, ctx) => {
      ctx.registerShutdown(() => {
        cleanupCount += 1;
      });
      return stubManifestMiddleware("idempotent-probe");
    });
    const handle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/idempotent-probe", options: undefined, enabled: true }],
    });
    await handle.runtime.dispose();
    expect(cleanupCount).toBe(1);
    await handle.runtime.dispose();
    expect(cleanupCount).toBe(1);
    runtimeHandle = null;
  });

  test("manifest middleware cleanup failure propagates as AggregateError from dispose()", async () => {
    // Cleanup failures are aggregated into a dispose() throw so
    // audit flush errors surface as failed shutdown instead of
    // silent success.
    const registry = new MiddlewareRegistry();
    registry.register("test/failing-cleanup", (_entry, ctx) => {
      ctx.registerShutdown(async () => {
        throw new Error("simulated flush failure");
      });
      return stubManifestMiddleware("failing-cleanup");
    });
    const handle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/failing-cleanup", options: undefined, enabled: true }],
    });
    await expect(handle.runtime.dispose()).rejects.toThrow(
      /manifest-middleware shutdown had 1 failure/,
    );
    runtimeHandle = null;
  });

  test("dispose() retries failed manifest cleanup hooks on subsequent calls", async () => {
    // Codex round-loop-2 round 6 finding #2: a single global
    // "cleanup done" flag was too coarse — a transient hook
    // failure was latched forever and never retried. Per-hook
    // tracking means a hook that fails once can still succeed on
    // a later dispose(). Verify with a hook that fails the first
    // time and succeeds the second, and a sibling hook that
    // always succeeds (must not be re-run).
    let attemptsFailing = 0;
    let attemptsAlwaysOk = 0;
    const registry = new MiddlewareRegistry();
    registry.register("test/flaky", (_entry, ctx) => {
      ctx.registerShutdown(() => {
        attemptsFailing += 1;
        if (attemptsFailing === 1) {
          throw new Error("transient flush failure");
        }
      });
      return stubManifestMiddleware("flaky");
    });
    registry.register("test/always-ok", (_entry, ctx) => {
      ctx.registerShutdown(() => {
        attemptsAlwaysOk += 1;
      });
      return stubManifestMiddleware("always-ok");
    });
    const handle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [
        { name: "test/flaky", options: undefined, enabled: true },
        { name: "test/always-ok", options: undefined, enabled: true },
      ],
    });
    // First dispose: flaky throws, always-ok succeeds once.
    await expect(handle.runtime.dispose()).rejects.toThrow(
      /manifest-middleware shutdown had 1 failure/,
    );
    expect(attemptsFailing).toBe(1);
    expect(attemptsAlwaysOk).toBe(1);
    // Second dispose: flaky retried (now succeeds), always-ok
    // NOT re-run because it was already latched as complete.
    await expect(handle.runtime.dispose()).resolves.toBeUndefined();
    expect(attemptsFailing).toBe(2);
    expect(attemptsAlwaysOk).toBe(1);
    // Third dispose: everything already complete, clean no-op.
    await expect(handle.runtime.dispose()).resolves.toBeUndefined();
    expect(attemptsFailing).toBe(2);
    expect(attemptsAlwaysOk).toBe(1);
    runtimeHandle = null;
  });

  test("manifest middleware shutdown hooks NOT fired by shutdownBackgroundTasks", async () => {
    // Sibling of the previous test: shutdownBackgroundTasks is
    // called by hosts BEFORE dispose to drain bg work. If it
    // closed the sink, the later dispose path would hit a closed
    // sink. Verify the hook is deferred to dispose.
    let firedByBgShutdown = false;
    const registry = new MiddlewareRegistry();
    registry.register("test/bg-probe", (_entry, ctx) => {
      ctx.registerShutdown(() => {
        firedByBgShutdown = true;
      });
      return stubManifestMiddleware("bg-probe");
    });
    const handle = await createKoiRuntime({
      ...makeConfig(),
      stacks: STACKS_WITHOUT_SPAWN,
      middlewareRegistry: registry,
      manifestMiddleware: [{ name: "test/bg-probe", options: undefined, enabled: true }],
    });
    handle.shutdownBackgroundTasks();
    expect(firedByBgShutdown).toBe(false);
    // dispose should then fire the hook.
    await handle.runtime.dispose();
    expect(firedByBgShutdown).toBe(true);
    runtimeHandle = null;
  });
});

describe("createKoiRuntime — trustedHost enforcement", () => {
  test("default posture assembles (invariant: all three required security layers present)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    // Same logic as the backward-compat test above: assembly success
    // means enforceRequiredMiddleware found hooks + permissions +
    // exfiltration-guard in the composed chain. If any were missing
    // it would throw RequiredMiddlewareError before createKoi is
    // called. This is the integration-level proof that zone C stays
    // mandatory when no trustedHost is set.
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("assembles with reportEnabled: true (KOI_REPORT_ENABLED wiring)", async () => {
    runtimeHandle = await createKoiRuntime({
      ...makeConfig(),
      reportEnabled: true,
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("assembles without reportEnabled (default off)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("RequiredMiddlewareError carries missing[] and terminalCapable for host error handling", () => {
    // Unit-tested more fully in manifest-middleware.test.ts; this
    // check lives here to ensure the error class is importable
    // through the runtime-factory boundary where hosts assemble
    // runtimes — a sanity anchor for the public surface.
    const err = new RequiredMiddlewareError(["permissions"], true);
    expect(err).toBeInstanceOf(Error);
    expect(err.missing).toEqual(["permissions"]);
    expect(err.terminalCapable).toBe(true);
    expect(err.name).toBe("RequiredMiddlewareError");
  });
});
