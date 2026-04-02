#!/usr/bin/env bun
/**
 * Test CLI — minimal interactive terminal for E2E testing.
 *
 * Wires createRuntime() with a real model adapter (OpenRouter) and event-trace
 * middleware. Prints a debug stack view on startup, then accepts prompts.
 *
 * Slash commands:
 *   /debug      — print middleware inventory + debug info
 *   /trajectory — print ATIF trajectory for the current session
 *   /quit       — exit
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/bin/test-cli.ts
 *
 * Superseded by @koi/cli + @koi/tui in Phase 2, but remains as a
 * lightweight test harness.
 */

import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { consumeModelStream } from "@koi/query-engine";
import { createRuntime, formatDebugInfo } from "../src/index.js";
import { createAtifDocumentStore } from "../src/trajectory/atif-store.js";
import { createFsAtifDelegate } from "../src/trajectory/fs-delegate.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY is required. Set it in .env or pass directly.");
  process.exit(1);
}

const MODEL = process.env.KOI_MODEL ?? "google/gemini-2.0-flash-001";
const TRAJ_DIR = process.env.KOI_TRAJECTORY_DIR ?? "/tmp/koi-test-cli-trajectory";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const modelAdapter = createOpenAICompatAdapter({
  apiKey: API_KEY,
  baseUrl: "https://openrouter.ai/api/v1",
  model: MODEL,
});

const trajectoryStore = createAtifDocumentStore(
  { agentName: "test-cli", agentVersion: "0.1.0" },
  createFsAtifDelegate(TRAJ_DIR),
);

const sessionDocId = `session-${crypto.randomUUID()}`;

const { middleware: eventTrace } = createEventTraceMiddleware({
  store: trajectoryStore,
  docId: sessionDocId,
  agentName: "test-cli",
});

// Adapter exposes terminals so the harness composes middleware + trajectory capture.
const cliAdapter: EngineAdapter = {
  engineId: "test-cli",
  capabilities: { text: true, images: false, files: false, audio: false },
  terminals: {
    modelCall: modelAdapter.complete,
    modelStream: modelAdapter.stream,
  },
  stream(input: EngineInput): AsyncIterable<EngineEvent> {
    const handlers = input.callHandlers;
    // callHandlers injected by compose layer
    const text = input.kind === "text" ? input.text : "";
    const modelRequest = {
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [{ kind: "text" as const, text }],
        },
      ],
      model: MODEL,
    };

    return (async function* () {
      if (handlers?.modelStream !== undefined) {
        yield* consumeModelStream(handlers.modelStream(modelRequest), input.signal);
      } else if (handlers !== undefined) {
        const response = await handlers.modelCall(modelRequest);
        yield {
          kind: "done" as const,
          output: {
            content: [{ kind: "text" as const, text: response.content }],
            stopReason: "completed" as const,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        };
      }
    })();
  },
};

const runtime = createRuntime({
  adapter: cliAdapter,
  middleware: [eventTrace],
  trajectoryDir: TRAJ_DIR,
  agentName: "test-cli",
  debug: true,
});

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

console.log("\n╭─────────────────────────────────╮");
console.log("│  Koi Test CLI — @koi/runtime    │");
console.log("╰─────────────────────────────────╯\n");

console.log(`Model: ${MODEL}`);
console.log(`Trajectory: ${TRAJ_DIR}`);
console.log(`Session: ${sessionDocId}\n`);

if (runtime.debugInfo) {
  console.log(formatDebugInfo(runtime.debugInfo));
}

console.log(`Trajectory store: ${runtime.trajectoryStore !== undefined ? "yes" : "NO"}`);
console.log("\nCommands: /debug, /trajectory, /quit\n");

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();

process.stdout.write("\n> ");

// let: mutable — accumulates partial input across reads
let inputBuffer = "";

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  // Slash commands
  if (trimmed === "/quit" || trimmed === "/exit") {
    console.log("\nGoodbye.");
    await runtime.dispose();
    process.exit(0);
  }

  if (trimmed === "/debug") {
    if (runtime.debugInfo) {
      console.log(`\n${formatDebugInfo(runtime.debugInfo)}\n`);
    } else {
      console.log("\nDebug info not available (debug: false)\n");
    }
    return;
  }

  if (trimmed === "/trajectory") {
    // Read from the runtime's trajectory store (harness-level steps)
    const runtimeStore = runtime.trajectoryStore;
    if (runtimeStore === undefined) {
      console.log("\nTrajectory store not configured.\n");
      return;
    }

    const { readdir: listDir } = await import("node:fs/promises");
    const files = await listDir(TRAJ_DIR).catch(() => [] as string[]);
    const atifFiles = files.filter((f: string) => f.endsWith(".atif.json"));

    const allSteps = [];
    for (const file of atifFiles) {
      const docId = decodeURIComponent(file.replace(".atif.json", ""));
      const docSteps = await runtimeStore.getDocument(docId);
      allSteps.push(...docSteps);
    }

    if (allSteps.length === 0) {
      console.log("\nNo trajectory data yet.\n");
      return;
    }

    const steps = allSteps;
    console.log(`\n=== Trajectory (${steps.length} steps) ===\n`);
    for (const step of steps) {
      const meta = step.metadata as Record<string, unknown> | undefined;
      const isSpan = step.identifier.startsWith("middleware:");
      if (isSpan) {
        console.log(
          `  [MW] ${step.identifier.replace("middleware:", "")} ` +
            `(${step.durationMs.toFixed(1)}ms, ${String(meta?.hook ?? "?")}) ` +
            `${step.outcome === "failure" ? "FAILED" : "ok"}`,
        );
        if (step.request?.text) console.log(`        in:  ${step.request.text.slice(0, 100)}`);
        if (step.response?.text) console.log(`        out: ${step.response.text.slice(0, 100)}`);
      } else {
        console.log(
          `  [${step.kind}] ${step.identifier} ` +
            `(${step.durationMs.toFixed(1)}ms) ${step.outcome}`,
        );
        if (step.request?.text) console.log(`        in:  ${step.request.text.slice(0, 200)}`);
        if (step.response?.text) console.log(`        out: ${step.response.text.slice(0, 200)}`);
      }
    }
    console.log();
    return;
  }

  // Regular prompt — send to model
  console.log();
  try {
    for await (const event of runtime.adapter.stream({
      kind: "text",
      text: trimmed,
    })) {
      if (event.kind === "text_delta") {
        process.stdout.write(event.delta);
      } else if (event.kind === "done") {
        console.log(`\n\n[${event.output.stopReason}]`);
      }
    }

    // Wait for harness trajectory flush (wrapStreamWithFlush finally block)
    // The async generator finally may need a tick to complete
    await new Promise((r) => setTimeout(r, 500));

    // Flush event-trace
    if (eventTrace.onAfterTurn) {
      await eventTrace.onAfterTurn({
        session: {
          agentId: "test-cli",
          sessionId: "cli" as never,
          runId: "cli:r0" as never,
          metadata: {},
        },
        turnIndex: 0,
        turnId: "cli:r0:t0" as never,
        messages: [],
        metadata: {},
      });
    }
  } catch (error: unknown) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// Read loop
while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  inputBuffer += decoder.decode(value, { stream: true });

  // Process complete lines
  const lines = inputBuffer.split("\n");
  // Keep the last (potentially incomplete) segment in the buffer
  inputBuffer = lines.pop() ?? "";

  for (const line of lines) {
    await processLine(line);
    process.stdout.write("> ");
  }
}

await runtime.dispose();
