#!/usr/bin/env bun
/**
 * Records a real-LLM golden cassette for @koi/agent-summary.
 *
 * Produces one cassette per granularity for a canonical 4-turn transcript.
 * The cassette stores the full ModelRequest that was sent and the raw
 * `{ text }` response the model produced. Replayed in golden-replay.test.ts
 * via a mock modelCall that returns the recorded text.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-agent-summary.ts
 *
 * Model: anthropic/claude-haiku-4-5 (cheap tier — matches cost router default).
 * Fixtures: packages/meta/runtime/fixtures/agent-summary-<granularity>.cassette.json
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Granularity, ModelRequest, SessionId } from "@koi/agent-summary";
import { createAgentSummary } from "@koi/agent-summary";
import type { SessionTranscript, TranscriptLoadResult } from "@koi/core";

const KEY = Bun.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const MODEL = "openai/gpt-4o-mini";

const TRANSCRIPT: TranscriptLoadResult = {
  entries: [
    {
      id: "u1" as never,
      role: "user",
      content: "list files in this directory",
      timestamp: 1,
    },
    {
      id: "a1" as never,
      role: "assistant",
      content: "I'll list the files.",
      timestamp: 2,
    },
    {
      id: "tc1" as never,
      role: "tool_call",
      content: "list({})",
      timestamp: 3,
    },
    {
      id: "tr1" as never,
      role: "tool_result",
      content: "[README.md, src/, package.json]",
      timestamp: 4,
    },
    {
      id: "u2" as never,
      role: "user",
      content: "any errors?",
      timestamp: 5,
    },
    {
      id: "a2" as never,
      role: "assistant",
      content: "No errors — the listing succeeded.",
      timestamp: 6,
    },
  ],
  skipped: [],
};

const transcript: SessionTranscript = {
  load: () => ({ ok: true, value: TRANSCRIPT }),
  loadPage: () => ({
    ok: true,
    value: { entries: [], total: 0, hasMore: false },
  }),
  compact: () => ({ ok: true, value: { preserved: 0 } }),
} as unknown as SessionTranscript;

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "status", "actions", "outcomes", "errors", "learnings"],
  properties: {
    goal: { type: "string" },
    status: { type: "string", enum: ["succeeded", "partial", "failed"] },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name", "paths", "detail"],
        properties: {
          kind: { type: "string", enum: ["tool_call", "edit", "decision"] },
          name: { type: "string" },
          paths: { type: ["array", "null"], items: { type: "string" } },
          detail: { type: ["string", "null"] },
        },
      },
    },
    outcomes: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: { type: "string" } },
    learnings: { type: "array", items: { type: "string" } },
  },
} as const;

async function callOpenRouter(req: ModelRequest): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: req.messages,
      max_tokens: req.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "session_summary",
          strict: true,
          schema: JSON_SCHEMA,
        },
      },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`openrouter ${resp.status}: ${body}`);
  }
  const json = (await resp.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices[0]?.message?.content ?? "";
}

interface Cassette {
  readonly generatedAt: string;
  readonly model: string;
  readonly granularity: Granularity;
  readonly transcript: TranscriptLoadResult;
  readonly modelRequest: ModelRequest;
  readonly modelResponse: { readonly text: string };
  readonly summary: unknown;
}

async function recordOne(granularity: Granularity): Promise<void> {
  let capturedReq: ModelRequest | undefined;
  let capturedText: string | undefined;

  const summary = createAgentSummary({
    transcript,
    modelCall: async (req) => {
      capturedReq = req;
      const text = await callOpenRouter(req);
      capturedText = text;
      return { text };
    },
  });

  const r = await summary.summarizeSession(`record-agent-summary-${granularity}` as SessionId, {
    granularity,
  });

  if (!r.ok) {
    throw new Error(
      `summarizeSession failed for ${granularity}: ${r.error.code} ${r.error.message} context=${JSON.stringify(r.error.context)}`,
    );
  }
  if (r.value.kind !== "clean") {
    throw new Error(`expected kind: clean, got ${r.value.kind}`);
  }
  if (!capturedReq || capturedText === undefined) {
    throw new Error("modelCall was not invoked");
  }

  const cassette: Cassette = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    granularity,
    transcript: TRANSCRIPT,
    modelRequest: capturedReq,
    modelResponse: { text: capturedText },
    summary: r.value.summary,
  };

  const path = join(FIXTURES_DIR, `agent-summary-${granularity}.cassette.json`);
  writeFileSync(path, JSON.stringify(cassette, null, 2));
  console.log(`✓ wrote ${path}`);
}

async function main(): Promise<void> {
  for (const g of ["high", "medium", "detailed"] as const) {
    await recordOne(g);
  }
  console.log("\nDone. Commit fixtures and add golden-replay assertions.");
}

await main();
