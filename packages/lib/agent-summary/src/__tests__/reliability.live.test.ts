import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionTranscript, TranscriptLoadResult } from "@koi/core";
import { createAgentSummary } from "../factory.js";
import {
  DEFAULT_TOKEN_BUDGETS,
  type Granularity,
  type ModelRequest,
  type SessionId,
} from "../types.js";

const KEY = Bun.env.OPENROUTER_API_KEY;
const SAMPLES = parsePositiveInt(Bun.env.RELIABILITY_SAMPLES, 10);
const MIN_SAMPLES_FOR_FIRST_TRY = parsePositiveInt(
  Bun.env.RELIABILITY_MIN_SAMPLES_FOR_FIRST_TRY,
  5,
);
const NETWORK_RETRIES = parsePositiveInt(Bun.env.RELIABILITY_NETWORK_RETRIES, 2);
const NETWORK_RETRY_DELAY_MS = parsePositiveInt(Bun.env.RELIABILITY_NETWORK_RETRY_DELAY_MS, 1000);
const MODELS: readonly string[] = [
  "anthropic/claude-haiku-4-5",
  "openai/gpt-4o-mini",
  "deepseek/deepseek-chat",
];
const GRANULARITIES: readonly Granularity[] = ["high", "medium", "detailed"];
const FIXTURES = ["clean-12turn.json", "crash-artifact.json", "compacted.json"] as const;
const RELIABILITY_TIMEOUT_MS = parsePositiveInt(
  Bun.env.RELIABILITY_TIMEOUT_MS,
  Math.max(120_000, MODELS.length * GRANULARITIES.length * FIXTURES.length * SAMPLES * 15_000),
);

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

interface OpenRouterCompletion {
  readonly text: string;
  readonly completionTokens: number | null;
}

async function openrouter(model: string, req: ModelRequest): Promise<OpenRouterCompletion> {
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
    try {
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
      if (!resp.ok) {
        if (attempt < NETWORK_RETRIES && isRetryableStatus(resp.status)) {
          await Bun.sleep(NETWORK_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        const responseText = await resp.text();
        throw new Error(`openrouter ${resp.status}: ${responseText.slice(0, 300)}`);
      }
      const json = (await resp.json()) as {
        readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
        readonly usage?: { readonly completion_tokens?: number };
      };
      const completionTokensRaw = json.usage?.completion_tokens;
      const completionTokens =
        typeof completionTokensRaw === "number" && Number.isFinite(completionTokensRaw)
          ? Math.max(0, Math.trunc(completionTokensRaw))
          : null;
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        completionTokens,
      };
    } catch (err) {
      if (attempt >= NETWORK_RETRIES) throw err;
      await Bun.sleep(NETWORK_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw new Error("openrouter retry loop exhausted");
}

interface ReliabilityRow {
  readonly model: string;
  readonly granularity: Granularity;
  readonly fixture: string;
  readonly parseSuccessFirstTry: number;
  readonly parseSuccessWithRetry: number;
  readonly schemaFieldCoverage: number;
  readonly tokenCapRespected: number;
  readonly failedRuns: number;
  readonly failureReasons: readonly string[];
}

describe.skipIf(!KEY)("reliability.live — opt-in only", () => {
  test(
    "sweep all models × granularities × fixtures",
    async () => {
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
            let failedRuns = 0;
            const failureReasons: string[] = [];

            for (let i = 0; i < SAMPLES; i++) {
              let retryCount = 0;
              let observedCompletionTokens: number | null = null;
              let observedText = "";
              let observedMaxTokens: number = DEFAULT_TOKEN_BUDGETS[g];
              const summary = createAgentSummary({
                transcript: mkTranscript(lr),
                modelCall: async (req) => {
                  observedMaxTokens = req.maxTokens;
                  const completion = await openrouter(model, req);
                  observedCompletionTokens = completion.completionTokens;
                  observedText = completion.text;
                  return { text: completion.text };
                },
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
                const completionTokens =
                  observedCompletionTokens ?? estimateCompletionTokens(observedText);
                if (completionTokens <= observedMaxTokens) capRespected++;
              } else {
                failedRuns++;
                failureReasons.push(formatFailureReason(r.error));
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
              failedRuns,
              failureReasons: [...new Set(failureReasons)],
            });
          }
        }
      }

      const outPath = join(import.meta.dir, "..", "..", "test-output", "reliability-report.json");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2));

      for (const row of report) {
        if (SAMPLES >= MIN_SAMPLES_FOR_FIRST_TRY) {
          expect(row.parseSuccessFirstTry).toBeGreaterThanOrEqual(0.85);
        }
        expect(row.parseSuccessWithRetry).toBeGreaterThanOrEqual(0.98);
        expect(row.schemaFieldCoverage).toBeGreaterThanOrEqual(0.9);
        expect(row.tokenCapRespected).toBe(1);
        expect(row.failedRuns).toBe(0);
      }
    },
    RELIABILITY_TIMEOUT_MS,
  );
});

function estimateCompletionTokens(text: string): number {
  // Rough fallback when provider usage is missing: ~4 chars/token in English.
  return Math.max(1, Math.ceil(text.length / 4));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function formatFailureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const maybeError = error as {
    readonly code?: unknown;
    readonly context?: { readonly reason?: unknown } | undefined;
  };
  const code = typeof maybeError.code === "string" ? maybeError.code : "UNKNOWN";
  const reason =
    typeof maybeError.context?.reason === "string" ? maybeError.context.reason : "unknown-reason";
  return `${code}:${reason}`;
}
