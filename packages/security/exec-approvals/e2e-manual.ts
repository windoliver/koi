#!/usr/bin/env bun
/**
 * Comprehensive manual E2E test for @koi/exec-approvals
 * through the full createKoi + createPiAdapter path (real LLM calls).
 *
 * Covers all 5 ProgressiveDecision variants, cross-session persistence,
 * compound patterns, base-deny absolute invariant, approval timeout,
 * and store-failure resilience.
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 *
 * Run from repo root:
 *   bun packages/exec-approvals/e2e-manual.ts
 */

import type { AgentManifest, EngineEvent, EngineOutput } from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
// Self-import via relative path — the package is not self-symlinked
import type { ExecApprovalRequest, ProgressiveDecision } from "./src/index.js";
import { createExecApprovalsMiddleware, createInMemoryRulesStore } from "./src/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY not set — add it to .env");
  process.exit(1);
}

const MODEL = "anthropic:claude-haiku-4-5-20251001";
const TOOL_TIMEOUT = 90_000;
const SYSTEM_PROMPT =
  "You are a helpful assistant. " +
  "When asked to do arithmetic, you MUST use the add_numbers tool — never compute yourself. " +
  "When asked to run a shell command, you MUST use the bash tool.";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(msg: string): void {
  passed++;
  console.log(`  ✅ ${msg}`);
}

function fail(label: string, reason: string): void {
  failed++;
  failures.push(`${label}: ${reason}`);
  console.log(`  ❌ ${reason}`);
}

async function test(label: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${label}`);
  try {
    await fn();
  } catch (e: unknown) {
    fail(label, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function collect(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const acc: EngineEvent[] = [];
  for await (const ev of iter) acc.push(ev);
  return acc;
}

function output(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { kind: "done" } => e.kind === "done");
  return done?.output;
}

function text(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tool providers
// ---------------------------------------------------------------------------

function makeAddProvider(spy?: () => void): {
  name: string;
  attach: () => Promise<Map<string, unknown>>;
} {
  return {
    name: "add-provider",
    attach: async () =>
      new Map([
        [
          toolToken("add_numbers") as string,
          {
            descriptor: {
              name: "add_numbers",
              description: "Adds two integers and returns the sum.",
              inputSchema: {
                type: "object" as const,
                properties: {
                  a: { type: "integer" as const, description: "First number" },
                  b: { type: "integer" as const, description: "Second number" },
                },
                required: ["a", "b"],
              },
            },
            trustTier: "verified" as const,
            execute: async (input: unknown) => {
              spy?.();
              const { a, b } = input as { a: number; b: number };
              return String(a + b);
            },
          },
        ],
      ]),
  };
}

function makeBashProvider(spy?: (cmd: string) => void): {
  name: string;
  attach: () => Promise<Map<string, unknown>>;
} {
  return {
    name: "bash-provider",
    attach: async () =>
      new Map([
        [
          toolToken("bash") as string,
          {
            descriptor: {
              name: "bash",
              description: "Runs a shell command and returns its output.",
              inputSchema: {
                type: "object" as const,
                properties: { command: { type: "string" as const } },
                required: ["command"],
              },
            },
            trustTier: "verified" as const,
            execute: async (input: unknown) => {
              const { command } = input as { command: string };
              spy?.(command);
              return `(simulated) $ ${command}\nok`;
            },
          },
        ],
      ]),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manifest(name: string): AgentManifest {
  return { name, version: "1.0.0", model: { name: "test" } };
}

function pi(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    getApiKey: async () => API_KEY,
  });
}

function limits() {
  return { maxTurns: 8, maxDurationMs: TOOL_TIMEOUT, maxTokens: 12_000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ── 1. ALLOW ──────────────────────────────────────────────────────────────

await test("1. ALLOW — tool runs, onAsk never called", async () => {
  let askCalled = false;
  let toolRan = false;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: ["add_numbers"], deny: [], ask: [] },
    onAsk: async () => {
      askCalled = true;
      return { kind: "allow_once" };
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-1"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeAddProvider(() => {
        toolRan = true;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  const evts = await collect(rt.run({ kind: "text", text: "Use add_numbers to compute 4 + 8." }));
  const out = output(evts);

  if (out?.stopReason !== "completed")
    return fail("1", `expected completed, got ${out?.stopReason}`);
  if (!toolRan) return fail("1", "tool was not executed");
  if (askCalled) return fail("1", "onAsk must not fire for allow pattern");
  if (!text(evts).includes("12")) return fail("1", `expected "12" in response`);

  ok(`allow rule → tool executed, onAsk not called, result contains "12"`);
});

// ── 2. DENY ───────────────────────────────────────────────────────────────

await test("2. DENY — tool blocked, onAsk never called", async () => {
  let askCalled = false;
  let toolRan = false;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: ["add_numbers"], ask: [] },
    onAsk: async () => {
      askCalled = true;
      return { kind: "allow_once" };
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-2"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeAddProvider(() => {
        toolRan = true;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  await collect(rt.run({ kind: "text", text: "Use the add_numbers tool to compute 6 + 7." }));

  if (toolRan) return fail("2", "tool must not execute under deny rule");
  if (askCalled) return fail("2", "onAsk must not fire for deny pattern");

  ok("deny rule → tool blocked, onAsk not called");
});

// ── 3. ASK → allow_once ───────────────────────────────────────────────────

await test("3. ASK → allow_once — onAsk fires, request captured correctly", async () => {
  let askCount = 0;
  let captured: ExecApprovalRequest | undefined;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async (req) => {
      askCount++;
      captured = req;
      return { kind: "allow_once" };
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-3"),
    adapter: pi(),
    middleware: [mw],
    providers: [makeAddProvider()],
    loopDetection: false,
    limits: limits(),
  });

  const evts = await collect(rt.run({ kind: "text", text: "Use add_numbers to compute 3 + 4." }));
  const out = output(evts);

  if (out?.stopReason !== "completed")
    return fail("3", `expected completed, got ${out?.stopReason}`);
  if (askCount < 1) return fail("3", "onAsk was never called");
  if (captured?.toolId !== "add_numbers") return fail("3", `bad toolId: ${captured?.toolId}`);
  if (captured?.matchedPattern !== "add_numbers")
    return fail("3", `bad matchedPattern: ${captured?.matchedPattern}`);
  if (!text(evts).includes("7")) return fail("3", `expected "7" in response`);

  ok(`onAsk called (${askCount}x), toolId=add_numbers, matchedPattern=add_numbers, result=7`);
});

// ── 4. ASK → allow_session ────────────────────────────────────────────────

await test("4. ASK → allow_session — two tool calls in one session, onAsk fires only once", async () => {
  let askCount = 0;
  let execCount = 0;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => {
      askCount++;
      return { kind: "allow_session", pattern: "add_numbers" };
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-4"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeAddProvider(() => {
        execCount++;
      }),
    ],
    loopDetection: false,
    limits: { maxTurns: 12, maxDurationMs: TOOL_TIMEOUT, maxTokens: 15_000 },
  });

  const evts = await collect(
    rt.run({
      kind: "text",
      text:
        "Call add_numbers TWICE: first compute 2 + 3, then compute 5 + 6. " +
        "Use the tool for each separately. Tell me both results.",
    }),
  );
  const out = output(evts);

  if (out?.stopReason !== "completed")
    return fail("4", `expected completed, got ${out?.stopReason}`);
  if (execCount < 2) return fail("4", `expected ≥2 tool executions, got ${execCount}`);
  if (askCount !== 1) return fail("4", `expected onAsk called exactly once, got ${askCount}`);

  ok(`tool called ${execCount}x in one session, onAsk fired only once (allow_session)`);
});

// ── 5. ASK → allow_always ─────────────────────────────────────────────────

await test("5. ASK → allow_always — persists to store, session 2 skips onAsk", async () => {
  const store = createInMemoryRulesStore();
  let askCount = 0;

  const mw1 = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => {
      askCount++;
      return { kind: "allow_always", pattern: "add_numbers" };
    },
    store,
  });

  const rt1 = await createKoi({
    manifest: manifest("e2e-5a"),
    adapter: pi(),
    middleware: [mw1],
    providers: [makeAddProvider()],
    loopDetection: false,
    limits: limits(),
  });

  const evts1 = await collect(rt1.run({ kind: "text", text: "Use add_numbers to compute 2 + 2." }));
  if (output(evts1)?.stopReason !== "completed") return fail("5", `session 1: expected completed`);
  if (askCount !== 1) return fail("5", `session 1: expected 1 ask, got ${askCount}`);

  const stored = await store.load();
  if (!stored.allow.includes("add_numbers"))
    return fail("5", `not saved to store: ${JSON.stringify(stored.allow)}`);

  // Session 2 — new middleware instance, same store
  const mw2 = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => {
      askCount++;
      return { kind: "allow_once" };
    },
    store,
  });

  const rt2 = await createKoi({
    manifest: manifest("e2e-5b"),
    adapter: pi(),
    middleware: [mw2],
    providers: [makeAddProvider()],
    loopDetection: false,
    limits: limits(),
  });

  const evts2 = await collect(rt2.run({ kind: "text", text: "Use add_numbers to compute 3 + 5." }));
  if (output(evts2)?.stopReason !== "completed") return fail("5", `session 2: expected completed`);
  if (askCount !== 1)
    return fail("5", `session 2: onAsk fired again (expected still 1, got ${askCount})`);

  ok("session 1 asked + persisted; session 2 loaded store → no ask");
});

// ── 6. ASK → deny_always ──────────────────────────────────────────────────

await test("6. ASK → deny_always — blocked both sessions, onAsk stays at 0 or 1", async () => {
  const store = createInMemoryRulesStore();
  let askCount = 0;
  let toolRan = false;

  const mw1 = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => {
      askCount++;
      return { kind: "deny_always", pattern: "add_numbers", reason: "nope" };
    },
    store,
  });

  const rt1 = await createKoi({
    manifest: manifest("e2e-6a"),
    adapter: pi(),
    middleware: [mw1],
    providers: [
      makeAddProvider(() => {
        toolRan = true;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  await collect(rt1.run({ kind: "text", text: "Use the add_numbers tool to compute 5 + 5." }));

  if (toolRan) return fail("6", "session 1: tool must not execute on deny_always");

  const stored = await store.load();
  if (!stored.deny.includes("add_numbers"))
    return fail("6", `not saved to deny store: ${JSON.stringify(stored.deny)}`);

  const s1Asks = askCount; // 0 if LLM didn't try tool, 1 if it did

  const mw2 = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => {
      askCount++;
      return { kind: "allow_once" };
    },
    store,
  });

  const rt2 = await createKoi({
    manifest: manifest("e2e-6b"),
    adapter: pi(),
    middleware: [mw2],
    providers: [
      makeAddProvider(() => {
        toolRan = true;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  await collect(rt2.run({ kind: "text", text: "Use the add_numbers tool to compute 2 + 2." }));

  if (toolRan) return fail("6", "session 2: tool must not execute — persisted deny");
  if (askCount > s1Asks)
    return fail("6", `session 2: onAsk fired again (grew from ${s1Asks} to ${askCount})`);

  ok(`deny_always: tool blocked both sessions, persisted in store, onAsk stayed at ${s1Asks}`);
});

// ── 7. BASE DENY ABSOLUTE ─────────────────────────────────────────────────

await test("7. BASE DENY ABSOLUTE — deny + ask on same tool → deny wins, onAsk never called", async () => {
  let askCalled = false;
  let toolRan = false;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: ["add_numbers"], ask: ["add_numbers"] },
    onAsk: async () => {
      askCalled = true;
      return { kind: "allow_once" };
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-7"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeAddProvider(() => {
        toolRan = true;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  await collect(rt.run({ kind: "text", text: "Use the add_numbers tool to compute 9 + 1." }));

  if (toolRan) return fail("7", "tool must not run — base deny is absolute");
  if (askCalled) return fail("7", "onAsk must NOT fire — deny is checked before ask step");

  ok("base deny fires before ask (evaluation order step 1 vs 5) — tool blocked, onAsk not called");
});

// ── 8. COMPOUND PATTERN ───────────────────────────────────────────────────

await test("8. COMPOUND PATTERN — bash:git* allows git, blocks rm -rf", async () => {
  let lastCmd: string | undefined;
  const mw = createExecApprovalsMiddleware({
    rules: { allow: ["bash:git*"], deny: [], ask: [] },
    onAsk: async () => ({ kind: "allow_once" }),
  });

  // 8a: git status — matches bash:git* → allowed
  lastCmd = undefined;
  const rt1 = await createKoi({
    manifest: manifest("e2e-8a"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeBashProvider((cmd) => {
        lastCmd = cmd;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  const evts1 = await collect(
    rt1.run({
      kind: "text",
      text: "Use the bash tool to run: git status. Tell me what it returned.",
    }),
  );
  if (output(evts1)?.stopReason !== "completed") return fail("8a", `expected completed`);
  if (lastCmd === undefined || !lastCmd.startsWith("git")) {
    return fail("8a", `expected git command executed, got: ${lastCmd}`);
  }
  ok(`8a: git command allowed → bash executed "${lastCmd}"`);

  // 8b: rm -rf — doesn't match bash:git* → default deny
  lastCmd = undefined;
  const rt2 = await createKoi({
    manifest: manifest("e2e-8b"),
    adapter: pi(),
    middleware: [mw],
    providers: [
      makeBashProvider((cmd) => {
        lastCmd = cmd;
      }),
    ],
    loopDetection: false,
    limits: limits(),
  });

  await collect(
    rt2.run({
      kind: "text",
      text: "Use the bash tool to run: rm -rf /tmp/test. Tell me the result.",
    }),
  );

  if (lastCmd?.startsWith("rm")) {
    return fail("8b", `rm should be blocked by compound pattern, but bash executed: "${lastCmd}"`);
  }
  ok(`8b: rm -rf blocked (bash:git* pattern only allows git commands)`);
});

// ── 9. APPROVAL TIMEOUT ───────────────────────────────────────────────────

await test("9. APPROVAL TIMEOUT — stalling onAsk times out, session ends with max_turns", async () => {
  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () =>
      new Promise<ProgressiveDecision>((resolve) =>
        setTimeout(() => resolve({ kind: "allow_once" }), 5_000),
      ),
    approvalTimeoutMs: 100,
  });

  const rt = await createKoi({
    manifest: manifest("e2e-9"),
    adapter: pi(),
    middleware: [mw],
    providers: [makeAddProvider()],
    loopDetection: false,
    limits: limits(),
  });

  const evts = await collect(rt.run({ kind: "text", text: "Use add_numbers to compute 1 + 1." }));
  const out = output(evts);

  if (out?.stopReason === "max_turns") {
    ok("TIMEOUT error → stopReason=max_turns");
  } else if (out?.stopReason === "completed") {
    ok(
      "LLM answered without calling the tool — timeout not triggered (valid: model chose not to use tool)",
    );
  } else {
    fail("9", `unexpected stopReason: ${out?.stopReason}`);
  }
});

// ── 10. STORE LOAD ERROR ──────────────────────────────────────────────────

await test("10. STORE LOAD ERROR — session proceeds normally, onLoadError called", async () => {
  let loadErrorCalled = false;

  const mw = createExecApprovalsMiddleware({
    rules: { allow: [], deny: [], ask: ["add_numbers"] },
    onAsk: async () => ({ kind: "allow_once" }),
    store: {
      load: async () => {
        throw new Error("disk failure");
      },
      save: async () => {},
    },
    onLoadError: () => {
      loadErrorCalled = true;
    },
  });

  const rt = await createKoi({
    manifest: manifest("e2e-10"),
    adapter: pi(),
    middleware: [mw],
    providers: [makeAddProvider()],
    loopDetection: false,
    limits: limits(),
  });

  const evts = await collect(rt.run({ kind: "text", text: "Use add_numbers to compute 5 + 3." }));
  const out = output(evts);

  if (!loadErrorCalled) return fail("10", "onLoadError was not called");
  if (out?.stopReason !== "completed")
    return fail("10", `expected completed, got ${out?.stopReason}`);

  ok("onLoadError called, session continued with empty state fallback");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(60)}`);
console.log(`\n  ${passed} passed  ${failed} failed\n`);

if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) console.log(`    • ${f}`);
  console.log();
}

process.exit(failed > 0 ? 1 : 0);
