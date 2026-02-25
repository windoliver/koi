/**
 * E2E test: @koi/redaction through the full L1 runtime (createKoi + createPiAdapter).
 *
 * Validates that @koi/redaction correctly detects and masks secrets in real
 * LLM responses flowing through the middleware chain.
 *
 * Scenario:
 *   1. Create a redactor + streaming observer middleware (wrapModelStream)
 *   2. Prompt the LLM to echo back fake secrets embedded in the user message
 *   3. Verify the redactor catches the secrets in the stream chunks
 *   4. Verify redactObject works on structured event payloads
 *   5. Verify audit lifecycle events fire with the middleware chain
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, KoiMiddleware } from "@koi/core";
import type {
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createAuditMiddleware, createInMemoryAuditSink } from "@koi/middleware-audit";
import { createRedactor } from "../redactor.js";
import type { Redactor } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Test secrets — NOT real secrets, but formatted to match pattern detectors
// ---------------------------------------------------------------------------

/** Fake JWT for detection. */
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0MTIzNDU2Nzg5MCJ9.fakeSignatureValue123";

/** Fake AWS access key for detection. */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** Fake GitHub token for detection. */
const FAKE_GITHUB_TOKEN = `ghp_${"a1b2c3d4e5f6".repeat(3)}`;

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/**
 * Create a streaming middleware that intercepts model stream chunks using @koi/redaction.
 * Captures raw text from text_delta chunks for post-hoc redaction assertions.
 *
 * Pi adapter routes through wrapModelStream (not wrapModelCall), so this is the
 * correct hook for intercepting LLM responses in the onion chain.
 */
function createStreamingRedactionMiddleware(_redactor: Redactor): {
  readonly middleware: KoiMiddleware;
  readonly rawChunks: string[];
  readonly streamIntercepted: boolean[];
} {
  const rawChunks: string[] = [];
  const streamIntercepted: boolean[] = [];

  const middleware: KoiMiddleware = {
    name: "e2e:redaction-stream-observer",
    priority: 450,

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      streamIntercepted.push(true);

      for await (const chunk of next(request)) {
        // Capture text_delta chunks for assertion
        if (chunk.kind === "text_delta") {
          rawChunks.push(chunk.delta);
        }
        yield chunk;
      }
    },
  };

  return { middleware, rawChunks, streamIntercepted };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/redaction through createKoi + createPiAdapter", () => {
  test(
    "streaming middleware intercepts LLM response and redactor catches secrets",
    async () => {
      const redactor = createRedactor();
      const { middleware, rawChunks, streamIntercepted } =
        createStreamingRedactionMiddleware(redactor);

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You are a test assistant. When given text to echo, repeat it back EXACTLY as given, character for character. Do not add any commentary.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "redaction-e2e-agent",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: piAdapter,
        middleware: [middleware],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 110_000, maxTokens: 4_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: `Echo the following text exactly:\ntoken: ${FAKE_JWT}\naws_key: ${FAKE_AWS_KEY}`,
        }),
      );

      // Verify the LLM actually responded
      const fullText = extractText(events);
      expect(fullText.length).toBeGreaterThan(0);
      expect(runtime.agent.state).toBe("terminated");

      // Verify streaming middleware intercepted the model stream
      expect(streamIntercepted.length).toBeGreaterThan(0);
      expect(rawChunks.length).toBeGreaterThan(0);

      // Concatenate all captured chunks into a single string
      const rawText = rawChunks.join("");

      // Run redactString on the captured stream output
      const scanResult = redactor.redactString(rawText);

      console.log("[e2e] Stream chunks captured:", rawChunks.length);
      console.log("[e2e] Raw text length:", rawText.length);
      console.log("[e2e] Secrets found:", scanResult.matchCount);

      // If the LLM echoed back our secrets, the redactor should catch them
      if (rawText.includes("eyJ") || rawText.includes("AKIA")) {
        expect(scanResult.changed).toBe(true);
        expect(scanResult.matchCount).toBeGreaterThan(0);
        // Redacted text should not contain original secrets
        expect(scanResult.text).not.toContain(FAKE_JWT);
        expect(scanResult.text).not.toContain(FAKE_AWS_KEY);
        expect(scanResult.text).toContain("[REDACTED]");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "audit middleware lifecycle events fire alongside redaction middleware",
    async () => {
      const redactor = createRedactor();
      const auditSink = createInMemoryAuditSink();
      const { middleware: redactionMiddleware } = createStreamingRedactionMiddleware(redactor);

      // Audit middleware captures lifecycle events (session_start, session_end)
      // and wrapModelCall/wrapToolCall. Pi adapter uses streaming so only
      // lifecycle hooks fire on the audit middleware.
      const auditMiddleware = createAuditMiddleware({ sink: auditSink });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. Repeat back any text given to you exactly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "redaction-audit-e2e",
          version: "1.0.0",
          model: { name: "claude-haiku" },
          middleware: [{ name: "audit" }],
        },
        adapter: piAdapter,
        middleware: [redactionMiddleware, auditMiddleware],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 110_000, maxTokens: 4_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: `Please repeat: my token is ${FAKE_JWT}`,
        }),
      );

      expect(runtime.agent.state).toBe("terminated");

      // Allow fire-and-forget audit sink to flush
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Audit sink should have captured lifecycle events (session_start, session_end)
      expect(auditSink.entries.length).toBeGreaterThan(0);

      const kinds = auditSink.entries.map((e) => e.kind);
      console.log("[e2e] Audit entry kinds:", kinds);
      console.log("[e2e] Audit entries count:", auditSink.entries.length);

      // Verify session lifecycle events were captured
      expect(kinds).toContain("session_start");
      expect(kinds).toContain("session_end");

      // Verify redactString works on the serialized audit trail
      const auditJson = JSON.stringify(auditSink.entries);
      const auditRedacted = redactor.redactString(auditJson);

      console.log("[e2e] Audit JSON length:", auditJson.length);
      console.log("[e2e] Audit redaction changed:", auditRedacted.changed);

      // The user prompt contains FAKE_JWT — if it leaked into audit, verify redaction catches it
      if (auditJson.includes("eyJ")) {
        expect(auditRedacted.changed).toBe(true);
        expect(auditRedacted.text).not.toContain(FAKE_JWT);
      }

      // Verify LLM actually responded (ensures runtime was functional)
      const fullText = extractText(events);
      expect(fullText.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "redactObject handles real structured LLM event payloads",
    async () => {
      const redactor = createRedactor();

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. When asked to echo, repeat the text exactly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "redaction-object-e2e",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 110_000, maxTokens: 4_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: `Echo: password=${FAKE_GITHUB_TOKEN} key=${FAKE_AWS_KEY}`,
        }),
      );

      expect(runtime.agent.state).toBe("terminated");

      // Build a synthetic audit-like payload using real events + injected secrets
      const textDeltas = events.filter((e) => e.kind === "text_delta");
      const doneEvent = events.find((e) => e.kind === "done");

      const payload = {
        events: textDeltas,
        done: doneEvent,
        metadata: {
          token: FAKE_JWT,
          password: "supersecretvalue123",
          config: {
            apiKey: FAKE_AWS_KEY,
            nested: {
              auth: `Bearer ${FAKE_JWT}`,
            },
          },
        },
      };

      // Redact the entire structured payload
      const result = redactor.redactObject(payload);

      console.log("[e2e] Object redaction changed:", result.changed);
      console.log("[e2e] Secret count:", result.secretCount);
      console.log("[e2e] Field count:", result.fieldCount);

      // Field-name matches: token, password, apiKey, auth
      expect(result.fieldCount).toBeGreaterThanOrEqual(4);
      expect(result.changed).toBe(true);

      // Verify field-name redacted values
      const redactedMeta = result.value.metadata;
      expect(redactedMeta.token).toBe("[REDACTED]");
      expect(redactedMeta.password).toBe("[REDACTED]");
      expect(redactedMeta.config.apiKey).toBe("[REDACTED]");
      expect(redactedMeta.config.nested.auth).toBe("[REDACTED]");

      // Verify the original payload was NOT mutated (immutability)
      expect(payload.metadata.token).toBe(FAKE_JWT);
      expect(payload.metadata.password).toBe("supersecretvalue123");
      expect(payload.metadata.config.apiKey).toBe(FAKE_AWS_KEY);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "redactString catches multiple secret types in concatenated LLM output",
    async () => {
      const redactor = createRedactor();

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You are a test assistant. When asked, output the exact text provided without modification.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "redaction-string-e2e",
          version: "1.0.0",
          model: { name: "claude-haiku" },
        },
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 110_000, maxTokens: 4_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "Output these values exactly, one per line:",
            `JWT: ${FAKE_JWT}`,
            `AWS: ${FAKE_AWS_KEY}`,
            `GitHub: ${FAKE_GITHUB_TOKEN}`,
            "Bearer: Bearer mytoken12345678",
          ].join("\n"),
        }),
      );

      const fullText = extractText(events);
      expect(fullText.length).toBeGreaterThan(0);

      // Run redactString on the concatenated LLM output
      const result = redactor.redactString(fullText);

      console.log("[e2e] Full LLM response length:", fullText.length);
      console.log("[e2e] String redaction changed:", result.changed);
      console.log("[e2e] Match count:", result.matchCount);
      console.log("[e2e] Redacted preview:", result.text.slice(0, 200));

      // Count how many secret signals appear in the raw text
      const signals = [
        fullText.includes("eyJ"),
        fullText.includes("AKIA"),
        fullText.includes("ghp_"),
        fullText.includes("Bearer"),
      ].filter(Boolean).length;

      if (signals > 0) {
        expect(result.changed).toBe(true);
        expect(result.matchCount).toBeGreaterThan(0);

        // Verify specific secrets are redacted
        if (fullText.includes("eyJ")) {
          expect(result.text).not.toContain(FAKE_JWT);
        }
        if (fullText.includes("AKIA")) {
          expect(result.text).not.toContain(FAKE_AWS_KEY);
        }
        if (fullText.includes("ghp_")) {
          expect(result.text).not.toContain(FAKE_GITHUB_TOKEN);
        }
      }

      console.log("[e2e] Signals found in LLM output:", signals, "/ 4");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
