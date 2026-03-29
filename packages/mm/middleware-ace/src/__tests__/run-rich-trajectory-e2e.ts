/**
 * Standalone script to run the rich trajectory e2e and dump all data.
 * Usage: bun run src/__tests__/run-rich-trajectory-e2e.ts
 */

import type { AuditEntry, ModelRequest, ModelResponse } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createAceMiddleware } from "../ace.js";
import { mapRichTrajectoryToAtif } from "../atif.js";
import { createAuditTrajectoryAdapter } from "../audit-adapter.js";
import { createDefaultCurator } from "../curator.js";
import { createDefaultReflector } from "../reflector.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryRichTrajectoryStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "../stores.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = "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";
const MODEL = "anthropic/claude-3.5-haiku";

// ---------------------------------------------------------------------------
// OpenRouter adapter (minimal, for this script only)
// ---------------------------------------------------------------------------

async function openRouterComplete(
  messages: readonly { readonly role: string; readonly content: string }[],
  tools?: readonly {
    readonly type: string;
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: unknown;
    };
  }[],
): Promise<{
  readonly content: string;
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: string }[];
}> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    max_tokens: 1024,
  };
  if (tools !== undefined && tools.length > 0) body.tools = tools;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as {
    readonly choices: readonly {
      readonly message: {
        readonly content?: string;
        readonly tool_calls?: readonly {
          readonly function: { readonly name: string; readonly arguments: string };
        }[];
      };
    }[];
  };

  const choice = json.choices[0];
  if (choice === undefined) throw new Error("No choices in response");

  const toolCalls = choice.message.tool_calls?.map((tc) => ({
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));

  return {
    content: choice.message.content ?? "",
    toolCalls,
  };
}

/** Text-only call for reflector/curator */
async function textCall(messages: readonly InboundMessage[]): Promise<string> {
  const mapped = messages.map((m) => ({
    role: "user" as const,
    content: m.content.map((c) => (c.kind === "text" ? c.text : JSON.stringify(c))).join("\n"),
  }));
  const result = await openRouterComplete(mapped);
  return result.content;
}

// ---------------------------------------------------------------------------
// Failing tool
// ---------------------------------------------------------------------------

const failingTool: Tool = {
  name: "write_protected_file",
  description: "Write content to a file path. May fail if the path is protected.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  execute: async (_args: unknown): Promise<string> => {
    throw new Error(
      "EACCES: permission denied, open '/etc/protected/config.yaml' — " +
        "file is owned by root:root with mode 0644, current user is 'deploy'. " +
        "Use sudo or change file ownership to proceed.",
    );
  },
};

// ---------------------------------------------------------------------------
// Simple model call that goes through OpenRouter with tool support
// ---------------------------------------------------------------------------

function createModelCall(): (req: ModelRequest) => Promise<ModelResponse> {
  return async (req: ModelRequest): Promise<ModelResponse> => {
    const messages = req.messages.map((m) => ({
      role: m.senderId.startsWith("system") ? ("system" as const) : ("user" as const),
      content: m.content.map((c) => (c.kind === "text" ? c.text : JSON.stringify(c))).join("\n"),
    }));

    // Pass tools if available
    const tools = req.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? {},
      },
    }));

    const result = await openRouterComplete(messages, tools);

    // If model wants to call tools, return as tool_use content
    if (result.toolCalls !== undefined && result.toolCalls.length > 0) {
      const tc = result.toolCalls[0];
      if (tc !== undefined) {
        return {
          content: [
            ...(result.content.length > 0 ? [{ kind: "text" as const, text: result.content }] : []),
            {
              kind: "tool_use" as const,
              toolCallId: `call_${Date.now()}`,
              toolName: tc.name,
              input: JSON.parse(tc.arguments),
            },
          ],
          model: MODEL,
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    }

    return {
      content: result.content,
      model: MODEL,
      stopReason: "completed",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Rich Trajectory E2E Test ===\n");

  // Stores (in-memory for the pipeline, we'll mirror to Nexus after)
  const trajectoryStore = createInMemoryTrajectoryStore();
  const playbookStore = createInMemoryPlaybookStore();
  const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();
  const richTrajectoryStore = createInMemoryRichTrajectoryStore();

  // Nexus config for mirroring results
  const NEXUS_URL = "http://localhost:40970";
  const NEXUS_API_KEY = "sk-iBjfhObGYgsJ6I0guPGsoDqQbuzpfXdXQOCP0ZbTOEc";
  const NEXUS_BASE = "agents/ace-rich-e2e/ace";

  // Audit sink (shared between audit middleware and ACE adapter)
  const auditEntries: AuditEntry[] = [];
  const auditSink = {
    async log(entry: AuditEntry): Promise<void> {
      auditEntries.push(entry);
    },
    async flush(): Promise<void> {},
    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      return auditEntries.filter((e) => e.sessionId === sessionId);
    },
  };

  // Inline audit middleware (can't import @koi/middleware-audit from L2 package)
  const auditMiddleware = {
    name: "audit-observer" as const,
    priority: 300,
    async wrapModelCall(
      ctx: import("@koi/core/middleware").TurnContext,
      request: ModelRequest,
      next: (req: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const startTime = Date.now();
      try {
        const response = await next(request);
        auditSink.log({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "model_call",
          request,
          response,
          durationMs: Date.now() - startTime,
        });
        return response;
      } catch (e: unknown) {
        auditSink.log({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "model_call",
          request,
          error: e,
          durationMs: Date.now() - startTime,
        });
        throw e;
      }
    },
    async wrapToolCall(
      ctx: import("@koi/core/middleware").TurnContext,
      request: import("@koi/core/middleware").ToolRequest,
      next: (
        req: import("@koi/core/middleware").ToolRequest,
      ) => Promise<import("@koi/core/middleware").ToolResponse>,
    ): Promise<import("@koi/core/middleware").ToolResponse> {
      const startTime = Date.now();
      try {
        const response = await next(request);
        auditSink.log({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "tool_call",
          request,
          response,
          durationMs: Date.now() - startTime,
        });
        return response;
      } catch (e: unknown) {
        auditSink.log({
          timestamp: startTime,
          sessionId: ctx.session.sessionId,
          agentId: ctx.session.agentId,
          turnIndex: ctx.turnIndex,
          kind: "tool_call",
          request,
          error: e,
          durationMs: Date.now() - startTime,
        });
        throw e;
      }
    },
  };

  const richTrajectorySource = createAuditTrajectoryAdapter({ sink: auditSink });
  const reflector = createDefaultReflector(textCall);
  const curator = createDefaultCurator(textCall);

  const pipelineErrors: unknown[] = [];
  const completedSessions: string[] = [];

  const aceMiddleware = createAceMiddleware({
    trajectoryStore,
    playbookStore,
    structuredPlaybookStore,
    richTrajectoryStore,
    reflector,
    curator,
    richTrajectorySource,
    playbookTokenBudget: 2000,
    maxReflectorTokens: 4000,
    minCurationScore: 0.01,
    onLlmPipelineError: (err) => {
      pipelineErrors.push(err);
    },
    onLlmPipelineComplete: (sessionId) => {
      completedSessions.push(sessionId);
    },
    onRecord: (entry) => {
      console.log(
        `  [ACE compact] ${entry.kind} ${entry.identifier}: ${entry.outcome} (${entry.durationMs}ms)`,
      );
    },
  });

  // ── SESSION 1: Simulate realistic audit entries ─────────────
  // (Simulates what audit middleware captures during a real koi up session
  //  where the agent tries to write to a protected file and fails)
  console.log("── Session 1: Simulated copilot conversation with tool failure ──\n");

  const sessionId = "demo-session-1";

  // Round 1: Model call — user asks to write, model decides to call tool
  console.log("  Round 1: User → Model → decides to call write_protected_file");
  await auditSink.log({
    timestamp: Date.now(),
    sessionId,
    agentId: "ace-rich-e2e",
    turnIndex: 0,
    kind: "model_call",
    request: {
      model: "claude-3.5-haiku",
      messages: [{ role: "user", content: "Write 'hello world' to /etc/protected/config.yaml" }],
    },
    response: {
      content: "I'll write that file for you using the write_protected_file tool.",
      toolCalls: [
        {
          name: "write_protected_file",
          arguments: { path: "/etc/protected/config.yaml", content: "hello world" },
        },
      ],
    },
    durationMs: 800,
  });

  // Round 2: Tool call — fails with EACCES
  console.log("  Round 2: Tool call → EACCES permission denied");
  await auditSink.log({
    timestamp: Date.now(),
    sessionId,
    agentId: "ace-rich-e2e",
    turnIndex: 1,
    kind: "tool_call",
    request: {
      toolId: "write_protected_file",
      arguments: { path: "/etc/protected/config.yaml", content: "hello world" },
    },
    error: {
      message:
        "EACCES: permission denied, open '/etc/protected/config.yaml' — file is owned by root:root with mode 0644, current user is 'deploy'. Use sudo or change file ownership to proceed.",
    },
    durationMs: 10,
  });

  // Round 3: Model sees error, explains the failure
  console.log("  Round 3: Model → explains the permission failure to user");
  await auditSink.log({
    timestamp: Date.now(),
    sessionId,
    agentId: "ace-rich-e2e",
    turnIndex: 2,
    kind: "model_call",
    request: {
      model: "claude-3.5-haiku",
      messages: [
        { role: "user", content: "Write 'hello world' to /etc/protected/config.yaml" },
        { role: "assistant", content: "I'll write that file..." },
        { role: "tool", content: "Error: EACCES: permission denied..." },
      ],
    },
    response: {
      content:
        "I wasn't able to write to /etc/protected/config.yaml due to a permission error. The file is owned by root and the current user 'deploy' doesn't have write access. You could try using sudo or writing to a user-accessible path like ~/config.yaml instead.",
    },
    durationMs: 600,
  });

  // Simulate compact trajectory entries (what ACE middleware normally records)
  const compactEntries = [
    {
      turnIndex: 0,
      timestamp: Date.now() - 2000,
      kind: "model_call" as const,
      identifier: "claude-3.5-haiku",
      outcome: "success" as const,
      durationMs: 800,
    },
    {
      turnIndex: 1,
      timestamp: Date.now() - 1000,
      kind: "tool_call" as const,
      identifier: "write_protected_file",
      outcome: "failure" as const,
      durationMs: 10,
    },
    {
      turnIndex: 2,
      timestamp: Date.now(),
      kind: "model_call" as const,
      identifier: "claude-3.5-haiku",
      outcome: "success" as const,
      durationMs: 600,
    },
  ];

  // Persist compact trajectory
  await trajectoryStore.append(sessionId, compactEntries);
  console.log(`\n  Session ended. Compact entries: ${compactEntries.length}`);

  // ── Run LLM pipeline directly ───────────────────────────────
  console.log("\n── Running LLM pipeline (reflector → curator) with real LLM ──\n");

  const { createLlmPipeline } = await import("../pipeline.js");
  const { createTrajectoryBuffer } = await import("../trajectory-buffer.js");

  const pipeline = createLlmPipeline({
    trajectoryStore,
    playbookStore,
    structuredPlaybookStore,
    richTrajectoryStore,
    reflector,
    curator,
    richTrajectorySource,
    playbookTokenBudget: 2000,
    maxReflectorTokens: 4000,
    onLlmPipelineComplete: (sid) => {
      completedSessions.push(sid);
    },
    onLlmPipelineError: (err) => {
      pipelineErrors.push(err);
    },
  });

  const buffer = createTrajectoryBuffer(100);
  for (const entry of compactEntries) buffer.record(entry);
  const flushed = buffer.flush();

  try {
    await pipeline.consolidate(flushed, sessionId, 1, Date.now, buffer);
    console.log(`  ✅ Pipeline completed for session: ${sessionId}`);
  } catch (err) {
    console.log("  ❌ Pipeline error:", err);
    pipelineErrors.push(err);
  }

  // ── DUMP: Audit entries ────────────────────────────────────
  console.log("\n── Audit Entries (what audit middleware captured) ──\n");
  for (const entry of auditEntries) {
    const reqSummary =
      entry.request !== undefined ? JSON.stringify(entry.request).slice(0, 150) : "none";
    const respSummary =
      entry.response !== undefined ? JSON.stringify(entry.response).slice(0, 150) : "none";
    const errSummary =
      entry.error !== undefined ? JSON.stringify(entry.error).slice(0, 150) : "none";
    console.log(`  [${entry.kind}] turn=${entry.turnIndex} duration=${entry.durationMs}ms`);
    console.log(`    request:  ${reqSummary}`);
    console.log(`    response: ${respSummary}`);
    if (entry.error !== undefined) console.log(`    error:    ${errSummary}`);
    console.log();
  }

  // ── DUMP: Rich trajectory store ────────────────────────────
  {
    const richSteps = await richTrajectoryStore.getSession(sessionId);
    console.log(`── Rich Trajectory Store (${richSteps.length} steps) ──\n`);
    for (const step of richSteps) {
      console.log(
        `  Step ${step.stepIndex}: [${step.kind}] ${step.identifier} → ${step.outcome} (${step.durationMs}ms)`,
      );
      if (step.request?.text !== undefined)
        console.log(
          `    Request:  ${step.request.text.slice(0, 200)}${step.request.text.length > 200 ? "..." : ""}`,
        );
      if (step.response?.text !== undefined)
        console.log(
          `    Response: ${step.response.text.slice(0, 200)}${step.response.text.length > 200 ? "..." : ""}`,
        );
      if (step.error?.text !== undefined)
        console.log(
          `    Error:    ${step.error.text.slice(0, 200)}${step.error.text.length > 200 ? "..." : ""}`,
        );
      if (step.request?.data !== undefined)
        console.log(`    Data:     ${JSON.stringify(step.request.data)}`);
      console.log();
    }

    // ── DUMP: ATIF export ──────────────────────────────────────
    console.log("── ATIF Export ──\n");
    const atifDoc = mapRichTrajectoryToAtif(richSteps, {
      sessionId,
      agentName: "ace-rich-e2e",
      agentVersion: "1.0.0",
    });
    console.log(`  schema_version: ${atifDoc.schema_version}`);
    console.log(`  session_id: ${atifDoc.session_id}`);
    console.log(`  steps: ${atifDoc.steps.length}`);
    if (atifDoc.final_metrics !== undefined) {
      console.log(`  final_metrics: ${JSON.stringify(atifDoc.final_metrics)}`);
    }
    console.log();
  }

  // ── DUMP: Structured playbook ──────────────────────────────
  const playbooks = await structuredPlaybookStore.list();
  console.log(`── Structured Playbooks (${playbooks.length}) ──\n`);
  for (const pb of playbooks) {
    console.log(`  ID: ${pb.id}`);
    console.log(`  Title: ${pb.title}`);
    console.log(`  Sessions: ${pb.sessionCount}`);
    for (const section of pb.sections) {
      console.log(`  ## ${section.name} (${section.bullets.length} bullets)`);
      for (const bullet of section.bullets) {
        console.log(`    ${bullet.id} (helpful=${bullet.helpful}, harmful=${bullet.harmful})`);
        console.log(`      ${bullet.content}`);
      }
    }
    console.log();
  }

  // ── DUMP: Stat playbooks ───────────────────────────────────
  const statPlaybooks = await playbookStore.list();
  console.log(`── Stat Playbooks (${statPlaybooks.length}) ──\n`);
  for (const pb of statPlaybooks) {
    console.log(`  ${pb.id}: confidence=${pb.confidence.toFixed(2)}`);
    console.log(`    ${pb.strategy}`);
    console.log();
  }

  // ── MIRROR TO NEXUS ─────────────────────────────────────────
  console.log("── Mirroring to Nexus ──\n");

  async function nexusWrite(path: string, content: string): Promise<void> {
    const resp = await fetch(`${NEXUS_URL}/api/nfs/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NEXUS_API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "write", params: { path, content } }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`  ⚠ Nexus write failed for ${path}: ${resp.status} ${text.slice(0, 100)}`);
    } else {
      const json = (await resp.json()) as { readonly error?: unknown };
      if (json.error !== undefined) {
        console.warn(
          `  ⚠ Nexus RPC error for ${path}: ${JSON.stringify(json.error).slice(0, 100)}`,
        );
      } else {
        console.log(`  ✅ ${path}`);
      }
    }
  }

  // Write rich trajectory steps
  const richSteps = await richTrajectoryStore.getSession(sessionId);
  for (const step of richSteps) {
    await nexusWrite(
      `${NEXUS_BASE}/rich-trajectories/${sessionId}/step-${step.stepIndex}.json`,
      JSON.stringify(step, null, 2),
    );
  }

  // Write ATIF export
  const atifDoc = mapRichTrajectoryToAtif(richSteps, {
    sessionId,
    agentName: "ace-rich-e2e",
    agentVersion: "1.0.0",
  });
  await nexusWrite(
    `${NEXUS_BASE}/atif-exports/${sessionId}.json`,
    JSON.stringify(atifDoc, null, 2),
  );

  // Write structured playbooks
  for (const pb of playbooks) {
    await nexusWrite(
      `${NEXUS_BASE}/structured-playbooks/${pb.id.replace(/:/g, "_")}.json`,
      JSON.stringify(pb, null, 2),
    );
  }

  // Write stat playbooks
  for (const pb of statPlaybooks) {
    await nexusWrite(
      `${NEXUS_BASE}/playbooks/${pb.id.replace(/:/g, "_")}.json`,
      JSON.stringify(pb, null, 2),
    );
  }

  console.log(`\n  Browse at: ${NEXUS_URL}`);
  console.log(`  Path prefix: ${NEXUS_BASE}/`);
  console.log(`  API key: ${NEXUS_API_KEY}`);

  console.log("\n=== Done ===");
}

main().catch(console.error);
