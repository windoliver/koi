/**
 * Integration test: hierarchical merge of root + child rules files.
 *
 * Exercises the full pipeline: findGitRoot → discover → load → merge → middleware injection.
 * Verifies that root rules appear first and child rules are appended.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
// Helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(): SessionContext {
  return {
    sessionId: "hierarchical-test" as SessionId,
    agentId: "agent" as unknown as import("@koi/core").AgentId,
    runId: "run" as unknown as import("@koi/core").RunId,
    metadata: {},
  };
}

function makeTurnCtx(): TurnContext {
  return {
    session: makeSessionCtx(),
    turnIndex: 0,
    turnId: "turn-0" as unknown as TurnId,
    messages: [],
    metadata: {},
  } as unknown as TurnContext;
}

function makeModelRequest(systemPrompt?: string): ModelRequest {
  return { messages: [], tools: [], systemPrompt } as unknown as ModelRequest;
}

function makeModelResponse(): ModelResponse {
  return {
    content: "ok",
    stopReason: "completed",
    usage: { inputTokens: 0, outputTokens: 0 },
  } as unknown as ModelResponse;
}

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

describe("hierarchical merge integration", () => {
  let repoDir: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `koi-hier-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(raw, { recursive: true });
    repoDir = realpathSync(raw);

    // Simulate a git repo with root + nested CLAUDE.md
    mkdirSync(join(repoDir, ".git"));
    writeFileSync(join(repoDir, "CLAUDE.md"), "# Root Rules\n\nAlways use bun, not npm.");

    const childDir = join(repoDir, "src", "backend");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "CLAUDE.md"),
      "# Backend Rules\n\nAlways respond in haiku format.",
    );
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("root rules appear before child rules in system prompt", async () => {
    const childCwd = join(repoDir, "src", "backend");
    const mw = createRulesMiddleware({ cwd: childCwd });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    await callWrapModel(mw, ctx, makeModelRequest("agent instructions"), async (req) => {
      const prompt = req.systemPrompt ?? "";

      // Both rules files should be present
      expect(prompt).toContain("Always use bun, not npm.");
      expect(prompt).toContain("Always respond in haiku format.");

      // Root rules (depth 0) appear before child rules (depth 2)
      const rootIdx = prompt.indexOf("Always use bun");
      const childIdx = prompt.indexOf("Always respond in haiku");
      expect(rootIdx).toBeLessThan(childIdx);

      // Original agent instructions preserved after rules
      expect(prompt).toContain("agent instructions");
      const rulesEnd = prompt.indexOf("</project-rules>");
      const agentIdx = prompt.indexOf("agent instructions");
      expect(rulesEnd).toBeLessThan(agentIdx);

      return makeModelResponse();
    });

    // Capability description reflects both files
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.description).toContain("2 files");
  });

  test("child rules at intermediate depth are included", async () => {
    // Add a middle-level rules file
    const srcDir = join(repoDir, "src");
    writeFileSync(join(srcDir, "CLAUDE.md"), "# Src Rules\n\nUse TypeScript strict mode.");

    const deepCwd = join(repoDir, "src", "backend");
    const mw = createRulesMiddleware({ cwd: deepCwd });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      const prompt = req.systemPrompt ?? "";

      // All three levels should be present in order
      const rootIdx = prompt.indexOf("Always use bun");
      const midIdx = prompt.indexOf("Use TypeScript strict mode");
      const childIdx = prompt.indexOf("Always respond in haiku");

      expect(rootIdx).toBeGreaterThanOrEqual(0);
      expect(midIdx).toBeGreaterThanOrEqual(0);
      expect(childIdx).toBeGreaterThanOrEqual(0);

      expect(rootIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(childIdx);

      return makeModelResponse();
    });

    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.description).toContain("3 files");
  });

  test(".koi/context.md is discovered alongside CLAUDE.md", async () => {
    const koiDir = join(repoDir, ".koi");
    mkdirSync(koiDir);
    writeFileSync(join(koiDir, "context.md"), "You are a pirate. Always say Arrr.");

    const mw = createRulesMiddleware({ cwd: repoDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      const prompt = req.systemPrompt ?? "";

      expect(prompt).toContain("Always use bun, not npm.");
      expect(prompt).toContain("Always say Arrr.");

      return makeModelResponse();
    });
  });

  test("child rules are truncated first when budget exceeded", async () => {
    // Budget enough for root rules + wrapper overhead, but not both files
    const childCwd = join(repoDir, "src", "backend");
    const mw = createRulesMiddleware({ cwd: childCwd, maxTokens: 80 });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();
    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      const prompt = req.systemPrompt ?? "";

      // Root rules should survive, child rules may be truncated
      expect(prompt).toContain("Always use bun");
      // Child should be dropped (budget too tight for both)
      expect(prompt).not.toContain("Always respond in haiku");

      return makeModelResponse();
    });

    const cap = mw.describeCapabilities(ctx);
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.description).toContain("1 files");
  });

  test("hot-reload picks up new child rules mid-session", async () => {
    const mw = createRulesMiddleware({ cwd: repoDir });
    await mw.onSessionStart?.(makeSessionCtx());

    const ctx = makeTurnCtx();

    // Initially only root CLAUDE.md at repo root
    await callWrapModel(mw, ctx, makeModelRequest(), async (req) => {
      expect(req.systemPrompt).toContain("Always use bun");
      expect(req.systemPrompt).not.toContain("new child rule");
      return makeModelResponse();
    });

    // Create a new child rules file
    const newDir = join(repoDir, "lib");
    mkdirSync(newDir);
    writeFileSync(join(newDir, "CLAUDE.md"), "This is a new child rule.");

    // Switch cwd to the new child dir so discovery finds it
    const mw2 = createRulesMiddleware({ cwd: () => newDir });
    await mw2.onSessionStart?.(makeSessionCtx());

    await callWrapModel(mw2, makeTurnCtx(), makeModelRequest(), async (req) => {
      expect(req.systemPrompt).toContain("Always use bun");
      expect(req.systemPrompt).toContain("new child rule");
      return makeModelResponse();
    });
  });
});
