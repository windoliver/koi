/**
 * Manual E2E script for @koi/agui — AG-UI SSE channel with a real LLM.
 *
 * Tests the full stack:
 *   createAguiHandler → createAguiStreamMiddleware
 *   → createKoi (L1 assembly + guards + middleware chain)
 *   → createPiAdapter → real Anthropic LLM
 *
 * Run:
 *   bun packages/agui/e2e.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { AgentManifest } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createAguiHandler } from "./src/agui-channel.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (API_KEY.length === 0) {
  console.error("ANTHROPIC_API_KEY not set — aborting.");
  process.exit(1);
}

const MODEL = "anthropic:claude-haiku-4-5-20251001";
const PORT = 19399;
const PATH = "/agent";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(label: string, detail?: string): void {
  console.log(`  ✓  ${label}${detail !== undefined ? `  (${detail})` : ""}`);
}

function fail(label: string, detail: string): void {
  console.error(`  ✗  ${label}  →  ${detail}`);
  process.exitCode = 1;
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 55 - title.length))}`);
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-e2e",
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: "m1", role: "user", content: 'Reply with exactly "hello world".' }],
    tools: [],
    context: [],
    ...overrides,
  };
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 30_000,
): Promise<readonly BaseEvent[]> {
  const events: BaseEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // let requires justification: partial frame buffer across ReadableStream chunks
  let buffer = "";

  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const trimmed = frame.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            events.push(JSON.parse(trimmed.slice(6)) as BaseEvent);
          } catch {
            // skip malformed frame
          }
        }
      }

      const last = events.at(-1);
      if (
        last !== undefined &&
        (last.type === EventType.RUN_FINISHED || last.type === EventType.RUN_ERROR)
      ) {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.cancel();
    } catch {
      // already cancelled
    }
  }

  return events;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

const manifest: AgentManifest = {
  name: "agui-e2e",
  version: "1.0.0",
  model: { name: MODEL },
};

// createAguiHandler owns no Bun.serve — embedded into the server below.
// mode: "stateless" — full message history sent each request (no memory middleware needed).
const {
  handler,
  middleware: aguiMw,
  onMessage,
} = createAguiHandler({
  path: PATH,
  mode: "stateless",
});

const piAdapter = createPiAdapter({
  model: MODEL,
  getApiKey: async () => API_KEY,
  systemPrompt: "You are a concise test assistant. Follow instructions exactly.",
});

const runtime = await createKoi({
  manifest,
  adapter: piAdapter,
  middleware: [aguiMw],
  loopDetection: false,
  limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 10_000 },
});

// Wire the AG-UI dispatch path to the Koi runtime.
// Each HTTP POST produces an InboundMessage with metadata.runId = AG-UI runId.
// Passing it as kind:"messages" threads the AG-UI runId through ctx.messages so
// createAguiStreamMiddleware resolves the correct SSE writer from the store.
onMessage(async (msg) => {
  for await (const _ of runtime.run({ kind: "messages", messages: [msg] })) {
    // Events are consumed to drive the agent loop.
    // createAguiStreamMiddleware intercepts wrapModelStream and writes SSE events
    // to the RunContextStore writer registered under the AG-UI runId.
  }
});

// Start a local Bun server for HTTP-level tests.
const server = Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const result = await handler(req);
    if (result !== null) {
      return result;
    }
    return new Response("Not Found", { status: 404 });
  },
});

const BASE = `http://localhost:${PORT}`;

// ── Test 1: Full SSE event set ─────────────────────────────────────────────────

async function testFullEventSet(): Promise<void> {
  section("1. Full SSE event set — all expected event types present");

  const res = await fetch(`${BASE}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makeInput()),
  });

  if (res.status !== 200) {
    fail("HTTP 200", `got ${String(res.status)}`);
    return;
  }
  pass("HTTP 200");

  if (res.headers.get("content-type")?.includes("text/event-stream") === true) {
    pass("content-type: text/event-stream");
  } else {
    fail("content-type", res.headers.get("content-type") ?? "null");
  }

  if (res.body === null) throw new Error("expected non-null body");
  const events = await readSseStream(res.body);
  const types = events.map((e) => e.type);

  const required = [
    EventType.RUN_STARTED,
    EventType.STATE_SNAPSHOT,
    EventType.STEP_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.STEP_FINISHED,
    EventType.RUN_FINISHED,
  ] as const;

  for (const expected of required) {
    if (types.includes(expected)) {
      pass(`emitted ${expected}`);
    } else {
      fail("missing event", expected);
    }
  }

  if (!types.includes(EventType.RUN_ERROR)) {
    pass("no RUN_ERROR");
  } else {
    const errEvent = events.find((e) => e.type === EventType.RUN_ERROR) as
      | { message?: string }
      | undefined;
    fail("unexpected RUN_ERROR", errEvent?.message ?? "(no message)");
  }
}

// ── Test 2: Real LLM text content ──────────────────────────────────────────────

async function testTextContent(): Promise<void> {
  section("2. Real LLM text content via middleware");

  const res = await fetch(`${BASE}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makeInput()),
  });

  if (res.body === null) throw new Error("expected non-null body");
  const events = await readSseStream(res.body);
  const text = events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");

  if (text.length > 0) {
    pass("TEXT_MESSAGE_CONTENT is non-empty (middleware fired)", `"${text.slice(0, 80)}"`);
  } else {
    fail("TEXT_MESSAGE_CONTENT", "empty — middleware runId lookup failed");
  }
}

// ── Test 3: Event ordering ─────────────────────────────────────────────────────

async function testOrdering(): Promise<void> {
  section("3. Event ordering — STEP wraps content, content precedes RUN_FINISHED");

  const res = await fetch(`${BASE}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makeInput()),
  });

  if (res.body === null) throw new Error("expected non-null body");
  const events = await readSseStream(res.body);
  const types = events.map((e) => e.type);

  const idx = (t: string): number => types.indexOf(t);
  const lastIdx = (t: string): number => types.lastIndexOf(t);

  // STEP_STARTED before TEXT_MESSAGE_START
  if (idx(EventType.STEP_STARTED) < idx(EventType.TEXT_MESSAGE_START)) {
    pass("STEP_STARTED < TEXT_MESSAGE_START");
  } else {
    fail(
      "STEP_STARTED ordering",
      `${String(idx(EventType.STEP_STARTED))} vs ${String(idx(EventType.TEXT_MESSAGE_START))}`,
    );
  }

  // STEP_FINISHED before RUN_FINISHED
  if (idx(EventType.STEP_FINISHED) < idx(EventType.RUN_FINISHED)) {
    pass("STEP_FINISHED < RUN_FINISHED");
  } else {
    fail(
      "STEP_FINISHED ordering",
      `${String(idx(EventType.STEP_FINISHED))} vs ${String(idx(EventType.RUN_FINISHED))}`,
    );
  }

  // Last TEXT_MESSAGE_CONTENT before RUN_FINISHED (P0 dispatch race regression)
  const lastContent = lastIdx(EventType.TEXT_MESSAGE_CONTENT);
  const runFinished = idx(EventType.RUN_FINISHED);
  if (lastContent !== -1 && lastContent < runFinished) {
    pass("last TEXT_MESSAGE_CONTENT < RUN_FINISHED (no dispatch race)");
  } else if (lastContent === -1) {
    fail("dispatch race check", "no TEXT_MESSAGE_CONTENT events");
  } else {
    fail(
      "dispatch race",
      `last TEXT_MESSAGE_CONTENT at ${String(lastContent)}, RUN_FINISHED at ${String(runFinished)}`,
    );
  }
}

// ── Test 4: Sequential requests reuse the same runtime ────────────────────────

async function testSequentialRequests(): Promise<void> {
  section("4. Sequential requests — same runtime, each gets a full response");

  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${BASE}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeInput()),
    });

    if (res.body === null) throw new Error("expected non-null body");
    const events = await readSseStream(res.body);
    const types = events.map((e) => e.type);
    const hasContent = types.includes(EventType.TEXT_MESSAGE_CONTENT);
    const hasFinished = types.includes(EventType.RUN_FINISHED);
    const hasError = types.includes(EventType.RUN_ERROR);

    if (hasContent && hasFinished && !hasError) {
      pass(`request ${String(i + 1)}: completed with content`);
    } else {
      fail(
        `request ${String(i + 1)}`,
        `content=${String(hasContent)} finished=${String(hasFinished)} error=${String(hasError)}`,
      );
    }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log("@koi/agui E2E — createAguiHandler + createKoi + createPiAdapter + real LLM");
console.log(`model: ${MODEL}  port: ${String(PORT)}`);

const t0 = Date.now();

await testFullEventSet();
await testTextContent();
await testOrdering();
await testSequentialRequests();

server.stop(true);
await runtime.dispose();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const ok = process.exitCode === undefined || process.exitCode === 0;
console.log(`\n${"─".repeat(58)}`);
console.log(`${ok ? "ALL PASS" : "FAILURES ABOVE"} — ${elapsed}s`);
