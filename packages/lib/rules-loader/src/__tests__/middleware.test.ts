import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelRequest,
  ModelResponse,
  SessionContext,
  SessionId,
  TurnContext,
  TurnId,
} from "@koi/core";

import { createRulesMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: "test-session" as SessionId,
    agentId: "test-agent" as unknown as import("@koi/core").AgentId,
    runId: "test-run" as unknown as import("@koi/core").RunId,
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(sessionId?: SessionId): TurnContext {
  return {
    session: makeSessionCtx({ sessionId: sessionId ?? ("test-session" as SessionId) }),
    turnIndex: 0,
    turnId: "turn-0" as unknown as TurnId,
    messages: [],
    metadata: {},
  } as unknown as TurnContext;
}

function makeModelRequest(systemPrompt?: string): ModelRequest {
  return {
    messages: [],
    tools: [],
    systemPrompt,
  } as unknown as ModelRequest;
}

function makeModelResponse(content: string): ModelResponse {
  return {
    content,
    stopReason: "completed",
    usage: { inputTokens: 0, outputTokens: 0 },
  } as unknown as ModelResponse;
}

/** Call wrapModelCall — throws if undefined (our middleware always defines it). */
function callWrapModel(
  mw: ReturnType<typeof createRulesMiddleware>,
  ctx: TurnContext,
  request: ModelRequest,
  next: (req: ModelRequest) => Promise<ModelResponse>,
): Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall is undefined");
  return mw.wrapModelCall(ctx, request, next);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRulesMiddleware", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `koi-rules-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, ".git"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("throws on invalid config", () => {
    expect(() => createRulesMiddleware({ maxTokens: -1 })).toThrow();
  });

  test("disabled config does not inject rules", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Rules");

    const mw = createRulesMiddleware({ enabled: false, cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const request = makeModelRequest("existing prompt");
    const response = makeModelResponse("ok");

    const result = await callWrapModel(mw, ctx, request, async (req) => {
      expect(req.systemPrompt).toBe("existing prompt");
      return response;
    });

    expect(result).toBe(response);
  });

  test("injects rules into systemPrompt on model call", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "Use bun, not npm.");

    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const request = makeModelRequest("agent instructions");

    await callWrapModel(mw, ctx, request, async (req) => {
      expect(req.systemPrompt).toContain("<project-rules>");
      expect(req.systemPrompt).toContain("Use bun, not npm.");
      expect(req.systemPrompt).toContain("agent instructions");
      return makeModelResponse("ok");
    });
  });

  test("prepends rules before existing systemPrompt", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "rules");

    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const request = makeModelRequest("existing");

    await callWrapModel(mw, ctx, request, async (req) => {
      const prompt = req.systemPrompt ?? "";
      const rulesIdx = prompt.indexOf("<project-rules>");
      const existingIdx = prompt.indexOf("existing");
      expect(rulesIdx).toBeLessThan(existingIdx);
      return makeModelResponse("ok");
    });
  });

  test("describeCapabilities returns summary when rules loaded", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "some rules");

    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.label).toBe("rules");
    expect(cap.description).toContain("1 files");
    expect(cap.description).toContain("tokens");
  });

  test("describeCapabilities returns undefined when disabled", () => {
    const mw = createRulesMiddleware({ enabled: false, cwd: tempDir });
    const ctx = makeTurnCtx();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeUndefined();
  });

  test("describeCapabilities returns undefined when no rules found", async () => {
    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeUndefined();
  });

  test("cleans up session state on end", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "rules");

    const mw = createRulesMiddleware({ cwd: tempDir });
    const sessionCtx = makeSessionCtx();
    await mw.onSessionStart?.(sessionCtx);

    const ctx = makeTurnCtx();
    expect(mw.describeCapabilities(ctx)).toBeDefined();

    await mw.onSessionEnd?.(sessionCtx);

    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  test("passes through when no rules loaded", async () => {
    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    const request = makeModelRequest("prompt");
    const response = makeModelResponse("ok");

    const result = await callWrapModel(mw, ctx, request, async (req) => {
      expect(req.systemPrompt).toBe("prompt");
      return response;
    });

    expect(result).toBe(response);
  });

  test("detects file changes on onBeforeTurn", async () => {
    const filePath = join(tempDir, "CLAUDE.md");
    writeFileSync(filePath, "original");

    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      expect(req.systemPrompt).toContain("original");
      return makeModelResponse("ok");
    });

    writeFileSync(filePath, "updated");
    const futureTime = new Date(Date.now() + 2000);
    utimesSync(filePath, futureTime, futureTime);

    await mw.onBeforeTurn?.(ctx);

    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      expect(req.systemPrompt).toContain("updated");
      return makeModelResponse("ok");
    });
  });

  test("picks up newly created rules files on onBeforeTurn", async () => {
    // Start with no rules files
    const mw = createRulesMiddleware({ cwd: tempDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    // Verify no rules injected initially
    await callWrapModel(mw, ctx, makeModelRequest("prompt"), async (req) => {
      expect(req.systemPrompt).toBe("prompt");
      return makeModelResponse("ok");
    });

    // Create a new rules file after session started
    writeFileSync(join(tempDir, "CLAUDE.md"), "newly added rules");

    // onBeforeTurn should detect the new file
    await mw.onBeforeTurn?.(ctx);

    await callWrapModel(mw, ctx, makeModelRequest("prompt"), async (req) => {
      expect(req.systemPrompt).toContain("newly added rules");
      return makeModelResponse("ok");
    });
  });
});
