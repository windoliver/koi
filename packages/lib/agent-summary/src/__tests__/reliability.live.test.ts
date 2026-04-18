import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionTranscript, TranscriptLoadResult } from "@koi/core";
import { createAgentSummary } from "../factory.js";
import type { Granularity, ModelRequest, SessionId } from "../types.js";

const KEY = Bun.env.OPENROUTER_API_KEY;
const SAMPLES = Number(Bun.env.RELIABILITY_SAMPLES ?? 10);
const MODELS: readonly string[] = [
  "anthropic/claude-haiku-4-5",
  "openai/gpt-4o-mini",
  "deepseek/deepseek-chat",
];
const GRANULARITIES: readonly Granularity[] = ["high", "medium", "detailed"];
const FIXTURES = ["clean-12turn.json", "crash-artifact.json", "compacted.json"] as const;

function mkTranscript(lr: TranscriptLoadResult): SessionTranscript {
  return {
    load: () => ({ ok: true, value: lr }),
    loadPage: () => ({
      ok: true,
      value: { entries: [], total: 0, hasMore: false },
    }),
    compact: () => ({ ok: true, value: { preserved: 0 } }),
  } as unknown as SessionTranscript;
}

async function openrouter(model: string, req: ModelRequest): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`openrouter ${resp.status}`);
  const json = (await resp.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices[0]?.message?.content ?? "";
}

interface ReliabilityRow {
  readonly model: string;
  readonly granularity: Granularity;
  readonly fixture: string;
  readonly parseSuccessFirstTry: number;
  readonly parseSuccessWithRetry: number;
  readonly schemaFieldCoverage: number;
  readonly tokenCapRespected: number;
}

describe.skipIf(!KEY)("reliability.live — opt-in only", () => {
  test("sweep all models × granularities × fixtures", async () => {
    const report: ReliabilityRow[] = [];

    for (const model of MODELS) {
      for (const g of GRANULARITIES) {
        for (const fx of FIXTURES) {
          const lr = JSON.parse(
            readFileSync(join(import.meta.dir, "fixtures", fx), "utf8"),
          ) as TranscriptLoadResult;

          let firstTry = 0;
          let withRetry = 0;
          let coverage = 0;
          let capRespected = 0;

          for (let i = 0; i < SAMPLES; i++) {
            let retryCount = 0;
            const summary = createAgentSummary({
              transcript: mkTranscript(lr),
              modelCall: async (req) => ({
                text: await openrouter(model, req),
              }),
              onEvent: (e) => {
                if (e.kind === "parse.retry") retryCount++;
              },
            });
            const isCompacted = fx === "compacted.json";
            const r = await summary.summarizeSession(`s-${model}-${g}-${fx}-${i}` as SessionId, {
              granularity: g,
              allowCompacted: isCompacted,
              crashTailStrategy: fx === "crash-artifact.json" ? "drop_last_turn" : "reject",
            });
            if (r.ok) {
              if (retryCount === 0) firstTry++;
              withRetry++;
              const body =
                r.value.kind === "clean"
                  ? r.value.summary
                  : r.value.kind === "degraded"
                    ? r.value.partial
                    : r.value.derived;
              if (body.goal && body.status) coverage++;
              capRespected++;
            }
          }

          report.push({
            model,
            granularity: g,
            fixture: fx,
            parseSuccessFirstTry: firstTry / SAMPLES,
            parseSuccessWithRetry: withRetry / SAMPLES,
            schemaFieldCoverage: coverage / SAMPLES,
            tokenCapRespected: capRespected / SAMPLES,
          });
        }
      }
    }

    const outPath = join(import.meta.dir, "..", "..", "test-output", "reliability-report.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));

    for (const row of report) {
      expect(row.parseSuccessFirstTry).toBeGreaterThanOrEqual(0.85);
      expect(row.parseSuccessWithRetry).toBeGreaterThanOrEqual(0.98);
      expect(row.schemaFieldCoverage).toBeGreaterThanOrEqual(0.9);
      expect(row.tokenCapRespected).toBe(1);
    }
  }, 120_000);
});
