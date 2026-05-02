#!/usr/bin/env bun

/**
 * E2E test for @koi/middleware-tool-error-formatter.
 *
 * Scenario A — recovery: model calls fragile tool that throws → formatter
 *   middleware (priority 170, resolve phase) catches and returns a formatted
 *   ToolResponse → model produces a follow-up agent step.
 *
 * Scenario B — secret redaction: tool throws an error containing a fake
 *   API key → formatter sanitizes before the ToolResponse reaches the model
 *   → trajectory full-text scan never contains the raw key.
 *
 * Run: OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/test-tool-safety-e2e-impl.ts
 *
 * Reuses the recordTrajectory wiring pattern from record-cassettes.ts (single
 * tool provider, openai-compat adapter, event-trace + hooks + permissions
 * + tool-error-formatter middleware). Skips semantic-retry: that classifier
 * loops on tool throws and would mask the formatter's behavior.
 */

import type {
  Agent,
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
} from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware, createMonotonicClock } from "@koi/event-trace";
import { createHookMiddleware, loadHooks } from "@koi/hooks";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createToolErrorFormatterMiddleware } from "@koi/middleware-tool-error-formatter";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import type { SourcedRule } from "@koi/permissions";
import { createPermissionBackend } from "@koi/permissions";
import { consumeModelStream } from "@koi/query-engine";
import { createSkillInjectorMiddleware } from "@koi/skills-runtime";
import { buildTool } from "@koi/tools-core";

import { createHookObserver } from "../src/middleware/hook-dispatch.js";
import { wrapMiddlewareWithTrace } from "../src/middleware/trace-wrapper.js";
import { createAtifDocumentStore } from "../src/trajectory/atif-store.js";
import { createFsAtifDelegate } from "../src/trajectory/fs-delegate.js";

const SECRET = "sk-test-1234567890abcdefABCDEF";
const MODEL = "google/gemini-2.0-flash-001";
const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const modelAdapter = createOpenAICompatAdapter({
  apiKey: API_KEY,
  baseUrl: "https://openrouter.ai/api/v1",
  model: MODEL,
  retry: { maxRetries: 1 },
});

const BYPASS_RULES: readonly SourcedRule[] = [
  { pattern: "*", action: "*", effect: "allow", source: "policy" },
];

function makeTool(name: string, throwMsg: string): ReturnType<typeof buildTool> {
  return buildTool({
    name,
    description: `Test tool that always throws: ${name}`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, query: { type: "string" } },
    },
    origin: "primordial",
    execute: async (_args: JsonObject): Promise<unknown> => {
      throw new Error(throwMsg);
    },
  });
}

interface RunResult {
  readonly trajectory: unknown;
  readonly trajectoryText: string;
  readonly steps: readonly RawStep[];
}

interface RawStep {
  readonly step_id: number;
  readonly source?: string;
  readonly outcome?: string;
  readonly extra?: { readonly type?: string; readonly middlewareName?: string };
  readonly observation?: { readonly results?: readonly { readonly content?: string }[] };
  readonly request?: unknown;
}

async function runScenario(args: {
  readonly name: string;
  readonly toolName: string;
  readonly throwMsg: string;
  readonly prompt: string;
}): Promise<RunResult> {
  const tool = args.throwMsg.length === 0 ? null : makeTool(args.toolName, args.throwMsg);
  if (!tool || !tool.ok) throw new Error(`buildTool failed`);
  const builtTool = tool.value;

  const trajDir = `/tmp/koi-tool-safety-e2e-${args.name}-${Date.now()}`;
  const docId = args.name;
  const store = createAtifDocumentStore(
    { agentName: `e2e-${args.name}` },
    createFsAtifDelegate(trajDir),
  );
  const clock = createMonotonicClock();

  const { middleware: eventTrace } = createEventTraceMiddleware({
    store,
    docId,
    agentName: `e2e-${args.name}`,
    clock,
  });

  const hookResult = loadHooks([]);
  const loadedHooks = hookResult.ok ? hookResult.value : [];
  const { onExecuted: hookObserverTap, middleware: hookObserverMw } = createHookObserver({
    store,
    docId,
    clock,
  });
  const coreHookMw = createHookMiddleware({ hooks: loadedHooks, onExecuted: hookObserverTap });

  const permBackend = createPermissionBackend({
    mode: "bypass",
    rules: [...BYPASS_RULES],
  });
  const permHandle = createPermissionsMiddleware({
    backend: permBackend,
    description: "bypass (allow all)",
  });

  const formatter = createToolErrorFormatterMiddleware();

  const agentRef: { current?: Agent } = {};
  const skillInjectorMw = createSkillInjectorMiddleware({
    agent: (): Agent => {
      if (agentRef.current === undefined) throw new Error("agent not wired");
      return agentRef.current;
    },
    progressive: true,
  });

  const middleware: readonly KoiMiddleware[] = [
    eventTrace,
    coreHookMw,
    hookObserverMw,
    permHandle,
    skillInjectorMw,
    formatter.middleware,
  ].map((mw) => wrapMiddlewareWithTrace(mw, { store, docId, clock }));

  const bridge: EngineAdapter = {
    engineId: `e2e-${args.name}`,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: modelAdapter.complete, modelStream: modelAdapter.stream },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const h = input.callHandlers;
      if (!h) throw new Error("no callHandlers");
      const msgs: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
        readonly metadata?: JsonObject;
      }[] = [];
      const text = input.kind === "text" ? input.text : "";
      msgs.push({ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text }] });
      const maxTurns = 2;
      return (async function* () {
        // let: mutable turn counter
        let turn = 0;
        while (turn < maxTurns + 1) {
          const evts: EngineEvent[] = [];
          // let: mutable done sentinel
          let done: EngineEvent | undefined;
          for await (const e of consumeModelStream(
            h.modelStream
              ? h.modelStream({ messages: msgs, model: MODEL })
              : (async function* (): AsyncIterable<ModelChunk> {
                  const r = await h.modelCall({ messages: msgs, model: MODEL });
                  yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
                })(),
            input.signal,
          )) {
            if (e.kind === "done") done = e;
            else {
              evts.push(e);
              yield e;
            }
          }
          const tcs = evts.filter((e) => e.kind === "tool_call_end");
          if (tcs.length === 0) {
            yield { kind: "turn_end" as const, turnIndex: turn };
            if (done) yield done;
            break;
          }
          for (const tc of tcs) {
            if (tc.kind !== "tool_call_end") continue;
            const r = tc.result as { readonly toolName: string; readonly parsedArgs?: JsonObject };
            if (!r.parsedArgs) continue;
            const realCallId = tc.callId as string;
            msgs.push({
              senderId: "assistant",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "" }],
              metadata: {
                callId: realCallId,
                callName: r.toolName,
                callArgs: JSON.stringify(r.parsedArgs ?? {}),
                toolName: r.toolName,
              } as JsonObject,
            });
            try {
              const resp = await h.toolCall({ toolId: r.toolName, input: r.parsedArgs });
              const out =
                typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
              msgs.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: out }],
                metadata: {
                  callId: realCallId,
                  toolCallId: realCallId,
                  toolName: r.toolName,
                } as JsonObject,
              });
            } catch (toolErr: unknown) {
              const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
              msgs.push({
                senderId: "tool",
                timestamp: Date.now(),
                content: [{ kind: "text", text: `error: ${errMsg}` }],
                metadata: { callId: realCallId, toolName: r.toolName } as JsonObject,
              });
            }
          }
          yield { kind: "turn_end" as const, turnIndex: turn };
          turn++;
        }
        yield {
          kind: "done" as const,
          output: {
            content: [],
            stopReason: "max_turns" as const,
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
          },
        };
      })();
    },
  };

  const providers: readonly ComponentProvider[] = [
    createSingleToolProvider({
      name: args.toolName,
      toolName: args.toolName,
      createTool: () => builtTool,
    }),
  ];

  const runtime = await createKoi({
    manifest: { name: `e2e-${args.name}`, version: "0.1.0", model: { name: MODEL } },
    adapter: bridge,
    middleware,
    providers: [...providers],
    loopDetection: false,
  });
  agentRef.current = runtime.agent;

  for await (const _e of runtime.run({ kind: "text", text: args.prompt })) {
    /* drain */
  }
  await runtime.dispose();

  // Wait for async trajectory writes (onSessionEnd flush).
  await new Promise((r) => setTimeout(r, 1500));

  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(trajDir);
  const meta = files.find((f) => f.endsWith(".atif.meta.json"));
  if (!meta) throw new Error(`no .atif.meta.json in ${trajDir}: ${files.join(",")}`);
  const state = JSON.parse(await readFile(`${trajDir}/${meta}`, "utf-8")) as {
    readonly document: Record<string, unknown>;
  };
  const stepFiles = files
    .filter((f) => /\.atif\.steps\.\d+\.json$/.test(f))
    .sort((a, b) => a.localeCompare(b));
  const steps: RawStep[] = [];
  for (const f of stepFiles) {
    const chunk = JSON.parse(await readFile(`${trajDir}/${f}`, "utf-8")) as readonly RawStep[];
    steps.push(...chunk);
  }
  const trajectory = { ...state.document, steps };
  const trajectoryText = JSON.stringify(trajectory);

  const { rmSync } = await import("node:fs");
  rmSync(trajDir, { recursive: true, force: true });

  return { trajectory, trajectoryText, steps };
}

interface ScenarioVerdict {
  readonly pass: boolean;
  readonly failure?: string;
  readonly evidence?: string;
}

function assertScenarioA(r: RunResult): ScenarioVerdict {
  const agentSteps = r.steps.filter((s) => s.source === "agent");
  if (agentSteps.length < 2) {
    return {
      pass: false,
      failure: `expected >=2 agent steps (model → tool throw → model recovery), got ${agentSteps.length}. step sources: ${r.steps.map((s) => s.source).join(",")}`,
    };
  }
  const toolFails = r.steps.filter((s) => s.source === "tool");
  if (toolFails.length === 0) {
    return { pass: false, failure: `expected >=1 tool step, got 0` };
  }
  const formatterSpan = r.steps.find(
    (s) =>
      s.extra?.type === "middleware_span" && s.extra?.middlewareName === "tool-error-formatter",
  );
  if (!formatterSpan) {
    return {
      pass: false,
      failure: `expected a middleware_span with middlewareName=tool-error-formatter; spans seen: ${r.steps
        .filter((s) => s.extra?.type === "middleware_span")
        .map((s) => s.extra?.middlewareName)
        .join(",")}`,
    };
  }
  return { pass: true };
}

function assertScenarioB(r: RunResult): ScenarioVerdict {
  if (r.trajectoryText.includes(SECRET)) {
    const idx = r.trajectoryText.indexOf(SECRET);
    return {
      pass: false,
      failure: `trajectory leaks raw secret '${SECRET}' at offset ${idx}. Surrounding: ...${r.trajectoryText.slice(Math.max(0, idx - 60), idx + 60)}...`,
    };
  }
  const hasRedactedMarker =
    r.trajectoryText.includes("[REDACTED]") || r.trajectoryText.includes("***");
  if (!hasRedactedMarker) {
    return {
      pass: false,
      failure: `trajectory has no [REDACTED] / *** marker; formatter may not have processed the throw. Raw secret pattern absent too — silent skip?`,
    };
  }
  const agentSteps = r.steps.filter((s) => s.source === "agent");
  if (agentSteps.length < 2) {
    return {
      pass: false,
      failure: `expected >=2 agent steps after redaction, got ${agentSteps.length}`,
    };
  }
  // Snippet: first redacted observation content
  const redactedToolStep = r.steps.find(
    (s) => s.source === "tool" && s.observation?.results?.[0]?.content?.includes("[REDACTED]"),
  );
  const evidence =
    redactedToolStep?.observation?.results?.[0]?.content?.slice(0, 160) ??
    "(no tool obs with [REDACTED])";
  return { pass: true, evidence };
}

const scenarioA = await runScenario({
  name: "scenario-a-recovery",
  toolName: "always_throws",
  throwMsg: "upstream service timed out after 30s",
  prompt:
    "Use the always_throws tool with id='abc-123'. After the tool call, briefly explain what happened to the user (one sentence).",
});
const verdictA = assertScenarioA(scenarioA);

const scenarioB = await runScenario({
  name: "scenario-b-redaction",
  toolName: "secret_leaker",
  throwMsg: `auth failed: token=${SECRET} rejected by gateway`,
  prompt:
    "Use the secret_leaker tool with query='lookup'. After the tool call, briefly explain what happened to the user (one sentence).",
});
const verdictB = assertScenarioB(scenarioB);

// ───────────────────────────────────────────────────────────────────────────
// Scenario C — fs-rollback restoration
// A protected tool writes a real file inside a temp git repo, then throws.
// The middleware must (a) snapshot before tool, (b) detect failure,
// (c) restore the file to its pre-call content, and (d) leave a
// fs-rollback middleware span in the trajectory.
//
// Self-contained: does NOT call OpenRouter — drives the middleware directly
// with a synthetic ToolHandler that simulates a partial write + throw.
// ───────────────────────────────────────────────────────────────────────────

interface ScenarioCResult {
  readonly verdict: ScenarioVerdict;
  readonly preCallContent: string;
  readonly midCallContent: string;
  readonly postRollbackContent: string;
}

async function runScenarioC(): Promise<ScenarioCResult> {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createFsRollbackMiddleware } = await import("@koi/middleware-fs-rollback");
  const { sessionId, runId } = await import("@koi/core");

  const dir = mkdtempSync(join(tmpdir(), `koi-fs-rollback-e2e-${Date.now()}-`));
  const filePath = join(dir, "report.md");
  // `let`: mid-call read happens inside the synthetic tool handler.
  let midCall = "";
  try {
    // Init real repo with committed baseline.
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    if (init.exitCode !== 0) throw new Error("git init failed");
    Bun.spawnSync(["git", "config", "user.email", "e2e@e2e"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.name", "e2e"], { cwd: dir });
    const baseline = "# Report\nbaseline content\n";
    writeFileSync(filePath, baseline);
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: dir });

    // Pre-call dirty state — the tree-state we expect rollback to restore.
    const preCall = "# Report\npending edit before tool ran\n";
    writeFileSync(filePath, preCall);

    // Run middleware over a synthetic tool that mid-writes, then throws.
    const handle = createFsRollbackMiddleware({ cwd: dir });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");

    const sessCtx: TurnContext = {
      session: {
        agentId: "e2e-fsrb",
        sessionId: sessionId("e2e-fsrb"),
        runId: runId("r1"),
        metadata: {},
      },
      turnIndex: 0,
      turnId: `${runId("r1")}-0` as TurnContext["turnId"],
      messages: [],
      metadata: {},
    };
    // Synthetic tool: writes "corrupted" mid-call, captures mid-call read,
    // then throws. The real-world analog is a fs_write that partially
    // commits before its post-write validation step fails.
    const next = async (): Promise<{ readonly output: unknown }> => {
      midCall = readFileSync(filePath, "utf-8");
      writeFileSync(filePath, "# Report\nCORRUPTED HALF-WRITE\n");
      throw new Error("simulated post-write validation error");
    };

    try {
      await wrap(sessCtx, { toolId: "fs_write", input: { path: "report.md" } }, next);
    } catch (_e: unknown) {
      // Expected throw — middleware re-throws the original tool error
      // after rolling back. Assertion below verifies the file content.
    }

    const post = readFileSync(filePath, "utf-8");
    const ok = post === preCall;
    return {
      verdict: ok
        ? {
            pass: true,
            evidence: `assert restored === preCall : "${post.replace(/\n/g, "\\n")}" === "${preCall.replace(/\n/g, "\\n")}"`,
          }
        : {
            pass: false,
            failure: `expected file to be restored to preCall content, got: ${JSON.stringify(post)}`,
          },
      preCallContent: preCall,
      midCallContent: midCall,
      postRollbackContent: post,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenarioC = await runScenarioC();
const verdictC = scenarioC.verdict;

console.log("\n══════════════════════════════════════");
console.log("  TOOL-SAFETY E2E TEST");
console.log(`  Scenario A (recovery):    ${verdictA.pass ? "PASS" : "FAIL"}`);
console.log(`  Scenario B (redaction):   ${verdictB.pass ? "PASS" : "FAIL"}`);
console.log(`  Scenario C (fs-rollback): ${verdictC.pass ? "PASS" : "FAIL"}`);
console.log("══════════════════════════════════════");

if (!verdictA.pass) console.log(`\n[A] FAIL: ${verdictA.failure}`);
if (!verdictB.pass) console.log(`\n[B] FAIL: ${verdictB.failure}`);
if (!verdictC.pass) console.log(`\n[C] FAIL: ${verdictC.failure}`);
if (verdictB.pass && verdictB.evidence) {
  console.log(`\n[B] redacted tool observation snippet:\n  ${verdictB.evidence}`);
}
if (verdictC.pass && verdictC.evidence) {
  console.log(`\n[C] rollback evidence:\n  ${verdictC.evidence}`);
  console.log(`  mid-call (during tool) : ${JSON.stringify(scenarioC.midCallContent)}`);
  console.log(`  post-rollback (after)  : ${JSON.stringify(scenarioC.postRollbackContent)}`);
}

process.exit(verdictA.pass && verdictB.pass && verdictC.pass ? 0 : 1);
