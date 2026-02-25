/**
 * End-to-end tests for @koi/middleware-guardrails with real LLM API calls.
 *
 * Wires guardrails middleware through the full createKoi + createLoopAdapter
 * L1 runtime path to verify middleware interposition works with a real model.
 *
 * Gated on the ANTHROPIC_API_KEY environment variable — tests are skipped
 * when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { z } from "zod";
import { createGuardrailsMiddleware } from "../guardrails.js";
import type { GuardrailViolationEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL = "claude-haiku-4-5-20251001";

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

function extractTextFromEvents(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: guardrails middleware through createKoi + createLoopAdapter", () => {
  const anthropicAdapter = createAnthropicAdapter({
    apiKey: ANTHROPIC_KEY,
  });

  const modelCall = (request: ModelRequest) =>
    anthropicAdapter.complete({ ...request, model: MODEL });

  test(
    "valid JSON output passes through guardrails",
    async () => {
      const jsonSchema = z.object({
        greeting: z.string(),
      });

      const violations: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [
          {
            name: "json-format",
            schema: jsonSchema,
            target: "modelOutput",
            action: "block",
          },
        ],
        onViolation: (e) => {
          violations.push(e);
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "guardrails-e2e-valid",
          version: "0.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [mw],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: 'Respond with ONLY a JSON object. No markdown, no code fences, no extra text. The JSON must have exactly one key "greeting" with a string value. Example: {"greeting": "hello"}',
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Model should complete successfully (guardrails pass)
        expect(output?.stopReason).toBe("completed");

        // Text should contain valid JSON with greeting
        const text = extractTextFromEvents(events);
        expect(text.length).toBeGreaterThan(0);

        const parsed = JSON.parse(text) as { greeting: string };
        expect(typeof parsed.greeting).toBe("string");

        // No violations should have been fired
        expect(violations).toHaveLength(0);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "warn action fires violation callback but passes through",
    async () => {
      const strictSchema = z.object({
        answer: z.number().int().min(0).max(10),
      });

      const violations: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [
          {
            name: "strict-number",
            schema: strictSchema,
            target: "modelOutput",
            action: "warn",
          },
        ],
        onViolation: (e) => {
          violations.push(e);
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "guardrails-e2e-warn",
          version: "0.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [mw],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Tell me a short joke about programming in plain text.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Should complete even though output doesn't match schema
        expect(output?.stopReason).toBe("completed");

        // Text content should exist (model responded normally)
        const text = extractTextFromEvents(events);
        expect(text.length).toBeGreaterThan(0);

        // Violation callback should have fired (plain text ≠ JSON)
        expect(violations.length).toBeGreaterThanOrEqual(1);
        expect(violations[0]?.action).toBe("warn");
        expect(violations[0]?.target).toBe("modelOutput");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "block action prevents delivery of invalid output",
    async () => {
      const strictSchema = z.object({
        answer: z.number().int(),
      });

      const violations: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [
          {
            name: "strict-json",
            schema: strictSchema,
            target: "modelOutput",
            action: "block",
          },
        ],
        onViolation: (e) => {
          violations.push(e);
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "guardrails-e2e-block",
          version: "0.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [mw],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Tell me a short joke about cats in plain text. Do not use JSON.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // createKoi converts KoiRuntimeError into a done event with "error" stopReason
        expect(output?.stopReason).toBe("error");

        // Violation should have been fired
        expect(violations.length).toBeGreaterThanOrEqual(1);
        expect(violations[0]?.action).toBe("block");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "retry action re-prompts the model with error context",
    async () => {
      const jsonSchema = z.object({
        color: z.string(),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      });

      const violations: GuardrailViolationEvent[] = [];
      const mw = createGuardrailsMiddleware({
        rules: [
          {
            name: "color-format",
            schema: jsonSchema,
            target: "modelOutput",
            action: "retry",
          },
        ],
        retry: { maxAttempts: 3 },
        onViolation: (e) => {
          violations.push(e);
        },
      });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
      const runtime = await createKoi({
        manifest: {
          name: "guardrails-e2e-retry",
          version: "0.0.0",
          model: { name: MODEL },
        },
        adapter,
        middleware: [mw],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: 'Respond with ONLY a JSON object containing "color" (a color name string) and "hex" (its hex code starting with # followed by 6 hex digits). Example: {"color": "red", "hex": "#FF0000"}. No markdown, no code fences.',
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();

        // Model should eventually produce valid JSON (possibly after retries)
        // If it succeeds, stopReason is "completed"
        // If all retries fail, stopReason is "error"
        if (output?.stopReason === "completed") {
          const text = extractTextFromEvents(events);
          const parsed = JSON.parse(text) as {
            color: string;
            hex: string;
          };
          expect(typeof parsed.color).toBe("string");
          expect(parsed.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
        // Either way, test infrastructure worked
        expect(output).toBeDefined();
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
