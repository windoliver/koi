/**
 * Tests for the plan-persist middleware (wrapToolCall dispatch).
 *
 * The backend has its own tests; here we exercise the wiring: tool-id
 * routing, sessionId injection from TurnContext, and the onSessionEnd
 * mirror cleanup.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  runId,
  type SessionContext,
  type SessionId,
  sessionId,
  type ToolRequest,
  type ToolResponse,
  type TurnContext,
  turnId,
} from "@koi/core";
import type { PlanPersistFs } from "./config.js";
import { createPlanPersistMiddleware } from "./plan-persist-middleware.js";
import { PLAN_LOAD_TOOL_NAME, PLAN_SAVE_TOOL_NAME } from "./tool-providers.js";
import type { PlanItem } from "./types.js";

const CWD = "/tmp/koi-plan-persist-mw-test";

function memFs(): PlanPersistFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>([CWD]);
  return {
    mkdir: async (p, _o): Promise<unknown> => {
      dirs.add(p);
      return undefined;
    },
    writeFile: async (p, d): Promise<void> => {
      files.set(p, d);
    },
    readFile: async (p, _e): Promise<string> => {
      const data = files.get(p);
      if (data === undefined) throw new Error("ENOENT");
      return data;
    },
    rename: async (a, b): Promise<void> => {
      const data = files.get(a);
      if (data === undefined) throw new Error("ENOENT");
      files.delete(a);
      files.set(b, data);
    },
    stat: async (p): Promise<unknown> => {
      if (!files.has(p) && !dirs.has(p)) throw new Error("ENOENT");
      return {};
    },
    realpath: async (p): Promise<string> => {
      if (!files.has(p) && !dirs.has(p)) throw new Error("ENOENT");
      return p;
    },
    unlink: async (p): Promise<void> => {
      files.delete(p);
    },
  };
}

function sessCtx(sid: SessionId): SessionContext {
  return { agentId: "test-agent", sessionId: sid, runId: runId("r1"), metadata: {} };
}

function turnCtx(session: SessionContext, idx = 0): TurnContext {
  return {
    session,
    turnIndex: idx,
    turnId: turnId(runId("r1"), idx),
    messages: [],
    metadata: {},
  };
}

const SAMPLE: readonly PlanItem[] = [{ content: "x", status: "pending" }];

const PASSTHROUGH = async (req: ToolRequest): Promise<ToolResponse> => ({
  output: { passthrough: req.toolId },
});

describe("createPlanPersistMiddleware — wiring", () => {
  test("returns a bundle with two providers and a plan-persist middleware", () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    expect(bundle.middleware.name).toBe("plan-persist");
    expect(bundle.providers).toHaveLength(2);
    expect(typeof bundle.onPlanUpdate).toBe("function");
  });

  test("custom priority is honored", () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs(), priority: 600 });
    expect(bundle.middleware.priority).toBe(600);
  });

  test("baseDir resolves under cwd", () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    expect(bundle.baseDir).toBe(resolve(CWD, ".koi/plans"));
  });

  test("throws when baseDir resolves outside cwd", () => {
    expect(() => createPlanPersistMiddleware({ baseDir: "/etc", cwd: CWD, fs: memFs() })).toThrow();
  });
});

describe("wrapToolCall — koi_plan_save", () => {
  test("delegates to backend.savePlan with sessionId from TurnContext", async () => {
    const bundle = createPlanPersistMiddleware({
      cwd: CWD,
      fs: memFs(),
      now: () => Date.UTC(2026, 3, 17, 10, 0, 0),
      rand: () => 0.5,
    });
    const sess = sessCtx(sessionId("sess-X"));
    bundle.onPlanUpdate(SAMPLE, {
      sessionId: "sess-X",
      epoch: 1,
      turnIndex: 0,
      signal: new AbortController().signal,
    });

    const req: ToolRequest = { toolId: PLAN_SAVE_TOOL_NAME, input: { slug: "feature-x" } };
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const res = await wrap(turnCtx(sess), req, PASSTHROUGH);

    const out = res.output as { readonly path?: string };
    expect(out.path).toContain("20260417-100000-feature-x.md");
    expect(res.metadata?.persistPath).toBeDefined();
  });

  test("returns plan-persist error when no plan has been mirrored yet", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const res = await wrap(
      turnCtx(sessCtx(sessionId("sess-empty"))),
      { toolId: PLAN_SAVE_TOOL_NAME, input: {} },
      PASSTHROUGH,
    );

    const out = res.output as { readonly error?: string };
    expect(out.error).toBe("no plan to save");
    expect(res.metadata?.planPersistError).toBe(true);
  });

  test("rejects a non-string slug with a clear error", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    bundle.onPlanUpdate(SAMPLE, {
      sessionId: "sess-1",
      epoch: 1,
      turnIndex: 0,
      signal: new AbortController().signal,
    });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const res = await wrap(
      turnCtx(sessCtx(sessionId("sess-1"))),
      { toolId: PLAN_SAVE_TOOL_NAME, input: { slug: 42 as unknown as string } },
      PASSTHROUGH,
    );
    const out = res.output as { readonly error?: string };
    expect(out.error).toBe("slug must be a string");
  });
});

describe("wrapToolCall — koi_plan_load", () => {
  test("rejects a missing path", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const res = await wrap(
      turnCtx(sessCtx(sessionId("s"))),
      { toolId: PLAN_LOAD_TOOL_NAME, input: {} },
      PASSTHROUGH,
    );
    const out = res.output as { readonly error?: string };
    expect(out.error).toBe("path must be a non-empty string");
  });

  test("rejects path traversal", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const res = await wrap(
      turnCtx(sessCtx(sessionId("s"))),
      { toolId: PLAN_LOAD_TOOL_NAME, input: { path: "/etc/passwd" } },
      PASSTHROUGH,
    );
    const out = res.output as { readonly error?: string };
    expect(out.error).toBe("path outside baseDir");
  });

  test("returns parsed items after a save+load round-trip", async () => {
    const bundle = createPlanPersistMiddleware({
      cwd: CWD,
      fs: memFs(),
      now: () => Date.UTC(2026, 3, 17, 10, 0, 0),
      rand: () => 0.5,
    });
    const sess = sessCtx(sessionId("sess-rt"));
    bundle.onPlanUpdate(SAMPLE, {
      sessionId: "sess-rt",
      epoch: 1,
      turnIndex: 0,
      signal: new AbortController().signal,
    });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const saved = await wrap(
      turnCtx(sess),
      { toolId: PLAN_SAVE_TOOL_NAME, input: { slug: "rt" } },
      PASSTHROUGH,
    );
    const savedOut = saved.output as { readonly path: string };

    const loaded = await wrap(
      turnCtx(sess),
      { toolId: PLAN_LOAD_TOOL_NAME, input: { path: savedOut.path } },
      PASSTHROUGH,
    );
    const out = loaded.output as { readonly items?: readonly PlanItem[] };
    expect(out.items).toEqual(SAMPLE);
    expect(loaded.metadata?.planLoadPath).toBe(savedOut.path);
  });
});

describe("wrapToolCall — passthrough", () => {
  test("forwards unrelated tool ids to next() unchanged", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    const wrap = bundle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");

    const res = await wrap(
      turnCtx(sessCtx(sessionId("s"))),
      { toolId: "some_other_tool", input: { x: 1 } },
      PASSTHROUGH,
    );
    expect(res.output).toEqual({ passthrough: "some_other_tool" });
  });
});

describe("onSessionEnd", () => {
  test("drops the mirror entry for the closed session", async () => {
    const bundle = createPlanPersistMiddleware({ cwd: CWD, fs: memFs() });
    bundle.onPlanUpdate(SAMPLE, {
      sessionId: "sess-end",
      epoch: 1,
      turnIndex: 0,
      signal: new AbortController().signal,
    });
    expect(bundle.getActivePlan("sess-end")).toEqual(SAMPLE);

    const onEnd = bundle.middleware.onSessionEnd;
    if (!onEnd) throw new Error("onSessionEnd missing");
    await onEnd({
      agentId: "a",
      sessionId: sessionId("sess-end"),
      runId: runId("r1"),
      metadata: {},
    });
    expect(bundle.getActivePlan("sess-end")).toBeUndefined();
  });
});
