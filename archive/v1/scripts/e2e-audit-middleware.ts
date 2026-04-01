#!/usr/bin/env bun
/**
 * E2E test script for @koi/middleware-audit — validates that the L0 audit
 * contract (AuditEntry, AuditSink, RedactionRule promoted to @koi/core)
 * works end-to-end with real Anthropic API calls through the full middleware
 * composition chain.
 *
 * Tests:
 *   1. Audit middleware captures model_call entries via real LLM call
 *   2. Audit entries conform to L0 AuditEntry contract shape
 *   3. Redaction rules strip sensitive data from logged payloads
 *   4. Session start/end lifecycle hooks fire correctly
 *   5. L0 type compatibility — custom AuditSink from @koi/core works directly
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-audit-middleware.ts
 *
 *   Or if .env has ANTHROPIC_API_KEY:
 *   bun scripts/e2e-audit-middleware.ts
 */

import type {
  AuditEntry,
  AuditSink,
  InboundMessage,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  RedactionRule,
} from "@koi/core";
import { composeModelChain, runSessionHooks } from "../packages/kernel/engine/src/compose.js";
import { createMockTurnContext } from "../packages/lib/test-utils/src/index.js";
import {
  createAuditMiddleware,
  createInMemoryAuditSink,
} from "../packages/security/middleware-audit/src/index.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting audit middleware E2E tests...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
  if (detail && !condition) console.log(`         ${detail}`);
}

function makeMessage(text: string): InboundMessage {
  return {
    senderId: "e2e-user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

/**
 * Real Anthropic API call as a ModelHandler terminal.
 */
function createAnthropicTerminal(): ModelHandler {
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const systemParts: string[] = [];
    const userParts: string[] = [];

    for (const msg of request.messages) {
      const text = msg.content
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => b.text)
        .join("\n");

      if (msg.senderId.startsWith("system:")) {
        systemParts.push(text);
      } else {
        userParts.push(text);
      }
    }

    const body = {
      model: request.model ?? "claude-haiku-4-5-20251001",
      max_tokens: request.maxTokens ?? 256,
      temperature: request.temperature ?? 0,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      messages: [{ role: "user", content: userParts.join("\n\n") }],
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as {
      readonly model: string;
      readonly content: readonly { readonly type: string; readonly text: string }[];
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    };

    return {
      content: json.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      model: json.model,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
    };
  };
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const terminal = createAnthropicTerminal();
const ctx = createMockTurnContext();

// ---------------------------------------------------------------------------
// Test 1 — Audit captures model_call entry via real LLM call
// ---------------------------------------------------------------------------

console.log("[test 1] Audit captures model_call via real LLM call");

const sink1 = createInMemoryAuditSink();
const auditMw1 = createAuditMiddleware({ sink: sink1 });

const auditChain1 = composeModelChain([auditMw1], terminal);

const response1 = await withTimeout(
  async () =>
    auditChain1(ctx, {
      messages: [makeMessage("Reply with exactly: AUDIT_OK")],
      maxTokens: 50,
      temperature: 0,
    }),
  30_000,
  "Test 1",
);

console.log(`  LLM response: "${response1.content.slice(0, 80)}"`);

// Give fire-and-forget audit log time to settle
await new Promise((r) => setTimeout(r, 100));

assert("LLM returned non-empty response", response1.content.length > 0);
assert(
  "audit sink captured 1 entry",
  sink1.entries.length === 1,
  `Got ${sink1.entries.length} entries`,
);

const entry1 = sink1.entries[0];
if (entry1) {
  assert("entry kind is 'model_call'", entry1.kind === "model_call");
  assert("entry has timestamp > 0", entry1.timestamp > 0);
  assert("entry has durationMs >= 0", entry1.durationMs >= 0, `Got ${entry1.durationMs}ms`);
  assert("entry has request payload", entry1.request !== undefined);
  assert("entry has response payload", entry1.response !== undefined);
  assert("entry has no error (successful call)", entry1.error === undefined);
  assert("entry agentId matches context", entry1.agentId === ctx.session.agentId);
  assert("entry sessionId matches context", entry1.sessionId === ctx.session.sessionId);
  assert("entry turnIndex matches context", entry1.turnIndex === ctx.turnIndex);
}

// ---------------------------------------------------------------------------
// Test 2 — AuditEntry contract shape validation (L0 type compatibility)
// ---------------------------------------------------------------------------

console.log("\n[test 2] AuditEntry contract shape — L0 type compatibility");

if (entry1) {
  // Validate all required L0 AuditEntry fields exist
  const requiredKeys: readonly (keyof AuditEntry)[] = [
    "timestamp",
    "sessionId",
    "agentId",
    "turnIndex",
    "kind",
    "durationMs",
  ];

  for (const key of requiredKeys) {
    assert(`entry has required field '${key}'`, key in entry1, `Missing field: ${key}`);
  }

  // Validate kind is one of the L0-defined union values
  const validKinds = ["model_call", "tool_call", "session_start", "session_end"] as const;
  assert(
    "entry.kind is a valid L0 union value",
    (validKinds as readonly string[]).includes(entry1.kind),
    `Got: "${entry1.kind}"`,
  );

  assert("timestamp is a number", typeof entry1.timestamp === "number");
  assert("sessionId is a string", typeof entry1.sessionId === "string");
  assert("agentId is a string", typeof entry1.agentId === "string");
  assert("turnIndex is a number", typeof entry1.turnIndex === "number");
  assert("durationMs is a number", typeof entry1.durationMs === "number");
}

// ---------------------------------------------------------------------------
// Test 3 — Redaction rules strip sensitive data
// ---------------------------------------------------------------------------

console.log("\n[test 3] Redaction rules strip sensitive data from audit entries");

const sink3 = createInMemoryAuditSink();
const redactionRules: readonly RedactionRule[] = [
  { pattern: /sk-[a-zA-Z0-9]{10,}/g, replacement: "[REDACTED_KEY]" },
  { pattern: /password["\s:=\\]+[^\s,}"\\]+/gi, replacement: "password=[REDACTED]" },
];

const auditMw3 = createAuditMiddleware({
  sink: sink3,
  redactionRules,
  maxEntrySize: 5_000,
});

const auditChain3 = composeModelChain([auditMw3], terminal);

const response3 = await withTimeout(
  async () =>
    auditChain3(ctx, {
      messages: [
        makeMessage(
          'The API key is sk-ant1234567890abcdef and password="secret123". Acknowledge these facts briefly.',
        ),
      ],
      maxTokens: 100,
      temperature: 0,
    }),
  30_000,
  "Test 3",
);

console.log(`  LLM response: "${response3.content.slice(0, 120)}"`);

await new Promise((r) => setTimeout(r, 100));

assert(
  "redaction: sink captured 1 entry",
  sink3.entries.length === 1,
  `Got ${sink3.entries.length}`,
);

const entry3 = sink3.entries[0];
if (entry3) {
  const serialized = JSON.stringify(entry3);
  assert(
    "redaction: API key is redacted in logged entry",
    !serialized.includes("sk-ant1234567890abcdef"),
    `Found raw key in: ${serialized.slice(0, 200)}`,
  );
  assert(
    "redaction: password is redacted in logged entry",
    !serialized.includes("secret123"),
    `Found raw password in: ${serialized.slice(0, 200)}`,
  );
  assert(
    "redaction: replacement marker present",
    serialized.includes("[REDACTED_KEY]") || serialized.includes("[REDACTED]"),
    "Expected redaction replacement markers",
  );
}

// ---------------------------------------------------------------------------
// Test 4 — Session lifecycle hooks (onSessionStart / onSessionEnd)
// ---------------------------------------------------------------------------

console.log("\n[test 4] Session lifecycle hooks fire audit entries");

const sink4 = createInMemoryAuditSink();
const auditMw4 = createAuditMiddleware({ sink: sink4 });

const sessionCtx = {
  agentId: "e2e-lifecycle-agent",
  sessionId: `session-${Date.now()}`,
  metadata: { test: "lifecycle" },
};

// Fire session hooks via the compose utility
await runSessionHooks([auditMw4], "onSessionStart", sessionCtx);

// Do a model call in between
const auditChain4 = composeModelChain([auditMw4], terminal);
await withTimeout(
  async () =>
    auditChain4(ctx, {
      messages: [makeMessage("Say hello.")],
      maxTokens: 30,
      temperature: 0,
    }),
  30_000,
  "Test 4 model call",
);

await runSessionHooks([auditMw4], "onSessionEnd", sessionCtx);

await new Promise((r) => setTimeout(r, 100));

assert(
  "lifecycle: 3 entries total (start + model_call + end)",
  sink4.entries.length === 3,
  `Got ${sink4.entries.length} entries: ${sink4.entries.map((e) => e.kind).join(", ")}`,
);

const kinds4 = sink4.entries.map((e) => e.kind);
assert(
  "lifecycle: first entry is session_start",
  kinds4[0] === "session_start",
  `Got: ${kinds4[0]}`,
);
assert("lifecycle: second entry is model_call", kinds4[1] === "model_call", `Got: ${kinds4[1]}`);
assert("lifecycle: third entry is session_end", kinds4[2] === "session_end", `Got: ${kinds4[2]}`);

const startEntry = sink4.entries[0];
if (startEntry) {
  assert(
    "lifecycle: session_start has correct agentId",
    startEntry.agentId === "e2e-lifecycle-agent",
  );
  assert("lifecycle: session_start has metadata", startEntry.metadata !== undefined);
}

// ---------------------------------------------------------------------------
// Test 5 — L0 type compatibility (custom AuditSink from @koi/core)
// ---------------------------------------------------------------------------

console.log("\n[test 5] L0 type compatibility — custom AuditSink from @koi/core");

// Build a custom AuditSink using only @koi/core types — proves L0 promotion works
const customEntries: AuditEntry[] = [];
const customSink: AuditSink = {
  log: async (entry: AuditEntry): Promise<void> => {
    customEntries.push(entry);
  },
  flush: async (): Promise<void> => {
    // no-op
  },
};

const auditMw5 = createAuditMiddleware({ sink: customSink });
const auditChain5 = composeModelChain([auditMw5], terminal);

const response5 = await withTimeout(
  async () =>
    auditChain5(ctx, {
      messages: [makeMessage("Say 'type check passed'.")],
      maxTokens: 30,
      temperature: 0,
    }),
  30_000,
  "Test 5",
);

console.log(`  LLM response: "${response5.content.slice(0, 80)}"`);

await new Promise((r) => setTimeout(r, 100));

assert(
  "L0 compat: custom AuditSink received entries",
  customEntries.length === 1,
  `Got ${customEntries.length}`,
);
assert("L0 compat: entry kind is model_call", customEntries[0]?.kind === "model_call");
assert(
  "L0 compat: entry has all required L0 fields",
  customEntries[0] !== undefined &&
    typeof customEntries[0].timestamp === "number" &&
    typeof customEntries[0].sessionId === "string" &&
    typeof customEntries[0].agentId === "string" &&
    typeof customEntries[0].turnIndex === "number" &&
    typeof customEntries[0].durationMs === "number",
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"─".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);
console.log("─".repeat(60));

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}`);
      if (r.detail) console.error(`        ${r.detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] ALL AUDIT MIDDLEWARE E2E TESTS PASSED!");
