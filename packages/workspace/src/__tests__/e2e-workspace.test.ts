/**
 * E2E: Workspace provider wired through the full createKoi + createPiAdapter stack.
 *
 * Validates that workspace isolation works end-to-end with a real LLM call:
 *   - Workspace attaches during agent assembly (createKoi)
 *   - Agent can reference the workspace component
 *   - Workspace cleanup respects policy after agent terminates
 *   - pruneStale hook fires on preservation
 *   - Preservation log emits correct policy + outcome
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test packages/workspace/src/__tests__/e2e-workspace.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  WorkspaceComponent,
} from "@koi/core";
import { toolToken, WORKSPACE } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { TempGitRepo } from "@koi/test-utils";
import { createTempGitRepo } from "@koi/test-utils";
import { createGitWorktreeBackend } from "../git-backend.js";
import { createWorkspaceProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

const WORKSPACE_KEY: string = WORKSPACE;

// Simple tool for provoking a multi-turn conversation
const ECHO_TOOL: Tool = {
  descriptor: {
    name: "echo",
    description: "Returns the input text as-is. Use to confirm you can call tools.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back" },
      },
      required: ["text"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return String(input.text ?? "");
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: workspace provider + createKoi + createPiAdapter", () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // ── Test 1: Workspace attaches during assembly and is accessible ──────

  test(
    "workspace component is available on agent after createKoi assembly",
    async () => {
      const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: pong",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "Workspace E2E Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      // Workspace component should be on the agent entity
      const ws = runtime.agent.component(WORKSPACE_KEY as never) as WorkspaceComponent | undefined;
      if (!ws) throw new Error("WORKSPACE component not found");
      expect(ws.path).toBeTruthy();
      expect(existsSync(ws.path)).toBe(true);

      // Run a simple LLM call to confirm the full stack works
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("success");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Detach — "always" policy should clean up
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      expect(existsSync(ws.path)).toBe(false);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: on_success policy cleans up after successful LLM run ──────

  test(
    "on_success cleanup after successful agent run (real LLM)",
    async () => {
      const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "on_success",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "Success-Cleanup Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      const ws = runtime.agent.component(WORKSPACE_KEY as never) as WorkspaceComponent;
      expect(existsSync(ws.path)).toBe(true);

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("success");

      // Detach with on_success — agent succeeded, so workspace should be cleaned up
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      expect(existsSync(ws.path)).toBe(false);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: on_success preserves workspace + fires pruneStale ─────────

  test(
    "on_success preserves workspace on interrupted + pruneStale fires",
    async () => {
      const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const pruneStale = mock(async (): Promise<void> => {});

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "on_success",
        pruneStale,
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the echo tool to respond. Always call echo with the user's message.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "Interrupt Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        providers: [providerResult.value, createToolProvider([ECHO_TOOL])],
        loopDetection: false,
      });

      const ws = runtime.agent.component(WORKSPACE_KEY as never) as WorkspaceComponent;
      expect(existsSync(ws.path)).toBe(true);

      // Start the run but abort it mid-stream to trigger "interrupted"
      const controller = new AbortController();

      const events: EngineEvent[] = [];
      for await (const event of runtime.run({
        kind: "text",
        text: "Use the echo tool with 'hello'. Then explain the result in detail.",
        signal: controller.signal,
      })) {
        events.push(event);
        // Abort after we see the first text delta — ensures partial progress
        if (event.kind === "text_delta") {
          controller.abort();
          break;
        }
      }

      // Agent should be terminated with "interrupted"
      expect(runtime.agent.state).toBe("terminated");
      expect(runtime.agent.terminationOutcome).toBe("interrupted");

      // Detach — on_success + interrupted → workspace preserved + pruneStale fires
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      expect(existsSync(ws.path)).toBe(true);
      expect(pruneStale).toHaveBeenCalledTimes(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Tool call through middleware + workspace coexist ───────────

  test(
    "workspace + tool provider + middleware all work together",
    async () => {
      const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "always",
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      // let justified: tracking middleware interception
      let toolCallCount = 0;
      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        wrapToolCall: async (_ctx, request, next) => {
          toolCallCount += 1;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the echo tool for every request. Call echo with the user's text.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "Multi-Provider Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        middleware: [toolObserver],
        providers: [providerResult.value, createToolProvider([ECHO_TOOL])],
        loopDetection: false,
      });

      // Both workspace and tool should be on the agent
      const ws = runtime.agent.component(WORKSPACE_KEY as never) as WorkspaceComponent;
      expect(ws).toBeDefined();
      expect(existsSync(ws.path)).toBe(true);

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Use echo with 'workspace test'" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware should have intercepted at least one tool call
      expect(toolCallCount).toBeGreaterThanOrEqual(1);

      // tool_call_start/end events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Detach — "always" cleans up
      if (providerResult.value.detach) {
        await providerResult.value.detach(runtime.agent);
      }
      expect(existsSync(ws.path)).toBe(false);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: pruneStale failure doesn't break detach ────────────────────

  test(
    "pruneStale failure is swallowed gracefully in full stack",
    async () => {
      const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
      if (!backendResult.ok) throw new Error(backendResult.error.message);

      const pruneStale = mock(async (): Promise<void> => {
        throw new Error("prune backend unavailable");
      });

      const providerResult = createWorkspaceProvider({
        backend: backendResult.value,
        cleanupPolicy: "never",
        pruneStale,
      });
      if (!providerResult.ok) throw new Error(providerResult.error.message);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "PruneStale-Fail Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        providers: [providerResult.value],
        loopDetection: false,
      });

      const ws = runtime.agent.component(WORKSPACE_KEY as never) as WorkspaceComponent;
      expect(existsSync(ws.path)).toBe(true);

      await collectEvents(runtime.run({ kind: "text", text: "Say: hi" }));

      expect(runtime.agent.state).toBe("terminated");

      // Detach — "never" policy preserves + pruneStale throws, but shouldn't leak
      if (providerResult.value.detach) {
        await expect(providerResult.value.detach(runtime.agent)).resolves.toBeUndefined();
      }

      // Workspace preserved, pruneStale was called despite throwing
      expect(existsSync(ws.path)).toBe(true);
      expect(pruneStale).toHaveBeenCalledTimes(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
