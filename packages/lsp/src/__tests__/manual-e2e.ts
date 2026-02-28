/**
 * Manual E2E validation — full createKoi + createPiAdapter pipeline with real LLM.
 *
 * Exercises the COMPLETE stack:
 *   ComponentProvider.attach() → agent entity assembly → middleware composition →
 *   pi adapter tool sanitization → real Anthropic API call → LLM tool use →
 *   tool execution → event bridge reverse-mapping → middleware intercept
 *
 * Run:
 *   bun packages/lsp/src/__tests__/manual-e2e.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import type {
  AgentManifest,
  EngineEvent,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { Diagnostic, LspClient } from "../index.js";
import { createLspTools } from "../index.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY not set. Add it to .env or export it.");
  process.exit(1);
}
console.log("API key loaded (%d chars)\n", ANTHROPIC_KEY.length);

// ---------------------------------------------------------------------------
// Mock LSP client — simulates a TypeScript language server
// ---------------------------------------------------------------------------

const mockClient: LspClient = {
  connect: async () => ({ ok: true, value: undefined }),
  hover: async () => ({
    ok: true,
    value: { contents: { kind: "markdown" as const, value: "**string** — primitive type" } },
  }),
  gotoDefinition: async () => ({ ok: true, value: [] }),
  findReferences: async () => ({ ok: true, value: [] }),
  documentSymbols: async () => ({
    ok: true,
    value: [
      {
        name: "greet",
        kind: 12 as const,
        location: {
          uri: "file:///project/src/main.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        },
      },
    ],
  }),
  workspaceSymbols: async () => ({ ok: true, value: [] }),
  openDocument: async () => ({ ok: true, value: undefined }),
  closeDocument: async () => ({ ok: true, value: undefined }),
  getDiagnostics: (_uri?: string) =>
    new Map<string, readonly Diagnostic[]>([
      [
        "file:///project/src/main.ts",
        [
          {
            range: { start: { line: 3, character: 10 }, end: { line: 3, character: 15 } },
            severity: 1 as const,
            message: "Type 'string' is not assignable to type 'number'.",
            source: "typescript",
            code: "TS2322",
          },
          {
            range: { start: { line: 7, character: 0 }, end: { line: 7, character: 12 } },
            severity: 2 as const,
            source: "typescript",
            message: "Variable 'unused' is declared but its value is never read.",
            tags: [1 as const],
          },
        ],
      ],
    ]),
  capabilities: () => ({ hoverProvider: true, documentSymbolProvider: true }),
  close: async () => {},
  isConnected: () => true,
  serverName: () => "ts",
};

// ---------------------------------------------------------------------------
// Build LSP ComponentProvider (same path as production)
// ---------------------------------------------------------------------------

const tools = createLspTools(mockClient, "ts", 100, 50);
console.log("LSP tools created: %d", tools.length);
for (const t of tools) {
  console.log("  tool: %s", t.descriptor.name);
}

const toolMap = new Map<string, unknown>();
for (const tool of tools) {
  toolMap.set(toolToken(tool.descriptor.name) as string, tool);
}

const lspProvider = {
  name: "lsp",
  attach: async () => toolMap as ReadonlyMap<string, unknown>,
  detach: async () => {},
};

// ---------------------------------------------------------------------------
// Middleware — observes tool calls through the chain
// ---------------------------------------------------------------------------

// let justified: mutable counters for middleware observation across turns
let middlewareToolCalls = 0;
const middlewareToolNames: string[] = [];

const observer: KoiMiddleware = {
  name: "e2e-observer",
  describeCapabilities: () => undefined,
  priority: 600,
  wrapToolCall: async (
    _ctx: TurnContext,
    request: ToolRequest,
    next: (req: ToolRequest) => Promise<ToolResponse>,
  ): Promise<ToolResponse> => {
    if (request.toolId.startsWith("lsp/")) {
      middlewareToolCalls++;
      middlewareToolNames.push(request.toolId);
      console.log("  [middleware] intercepted tool call: %s", request.toolId);
    }
    return next(request);
  },
};

// ---------------------------------------------------------------------------
// Create runtime via full L1 assembly path
// ---------------------------------------------------------------------------

const manifest: AgentManifest = {
  name: "lsp-manual-e2e",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

const piAdapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: [
    "You are a code analysis assistant with LSP tools.",
    "You MUST use the lsp_ts_get_diagnostics tool to check for errors.",
    "Report what errors you find. Be concise.",
  ].join(" "),
  thinkingLevel: "off",
  getApiKey: async () => ANTHROPIC_KEY,
});

console.log("\nCreating runtime via createKoi (full L1 assembly)...");
const runtime = await createKoi({
  manifest,
  adapter: piAdapter,
  providers: [lspProvider],
  middleware: [observer],
  loopDetection: false,
  limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
});
console.log("Runtime created. Conflicts: %d", runtime.conflicts.length);

// Verify tools are on the agent entity
const entityTools = runtime.agent.query("tool:");
console.log("Agent entity tools: %d", entityTools.size);
for (const [key] of entityTools) {
  console.log("  entity key: %s", key);
}

// ---------------------------------------------------------------------------
// Run the agent — real LLM call through the full pipeline
// ---------------------------------------------------------------------------

console.log("\n=== Running agent (real LLM call) ===\n");

const events: EngineEvent[] = [];
// let justified: accumulate text delta for display
let fullText = "";

for await (const event of runtime.run({
  kind: "text",
  text: "Check file:///project/src/main.ts for compiler errors using the diagnostics tool.",
})) {
  events.push(event);

  switch (event.kind) {
    case "text_delta":
      fullText += event.delta;
      process.stdout.write(event.delta);
      break;
    case "tool_call_start":
      console.log("\n  [TOOL CALL] %s (callId: %s)", event.toolName, event.callId);
      break;
    case "tool_call_end":
      console.log("  [TOOL END] callId: %s", event.callId);
      break;
    case "turn_start":
      console.log("  [TURN START] index=%d", event.turnIndex);
      break;
    case "turn_end":
      console.log("  [TURN END] index=%d", event.turnIndex);
      break;
    case "done":
      console.log(
        "\n  [DONE] stopReason=%s tokens=%d turns=%d duration=%dms",
        event.output.stopReason,
        event.output.metrics.totalTokens,
        event.output.metrics.turns,
        event.output.metrics.durationMs,
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

console.log("\n=== Validation ===\n");

const toolCallEvents = events.filter((e) => e.kind === "tool_call_start");
const doneEvent = events.find((e) => e.kind === "done");

// 1. Tool was called
const toolCount = toolCallEvents.length;
console.log("1. Tool calls emitted: %d %s", toolCount, toolCount > 0 ? "PASS" : "FAIL");

// 2. Tool name uses original Koi name (reverse-mapped from sanitized API name)
const lspCalls = toolCallEvents.filter(
  (e) => e.kind === "tool_call_start" && e.toolName.startsWith("lsp/ts/"),
);
console.log(
  "2. LSP tool names reverse-mapped (lsp/ts/ prefix): %d %s",
  lspCalls.length,
  lspCalls.length > 0 ? "PASS" : "FAIL",
);

// 3. Middleware intercepted the tool calls (proves middleware chain works)
console.log(
  "3. Middleware intercepted tool calls: %d %s",
  middlewareToolCalls,
  middlewareToolCalls > 0 ? "PASS" : "FAIL",
);
if (middlewareToolNames.length > 0) {
  console.log("   Middleware saw tool IDs: %s", middlewareToolNames.join(", "));
}

// 4. Done event with tokens
const tokens = doneEvent?.kind === "done" ? doneEvent.output.metrics.totalTokens : 0;
console.log("4. Tokens consumed: %d %s", tokens, tokens > 0 ? "PASS" : "FAIL");

// 5. Response text mentions the error
const mentionsError = fullText.toLowerCase().match(/type|error|assign|string|number/i) !== null;
console.log("5. Response references the diagnostic: %s", mentionsError ? "PASS" : "FAIL");

// 6. Stop reason
const stopReason = doneEvent?.kind === "done" ? doneEvent.output.stopReason : "unknown";
console.log("6. Stop reason: %s %s", stopReason, stopReason === "completed" ? "PASS" : "FAIL");

// Summary
const allPass =
  toolCount > 0 &&
  lspCalls.length > 0 &&
  middlewareToolCalls > 0 &&
  tokens > 0 &&
  mentionsError &&
  stopReason === "completed";
console.log("\n=== %s ===\n", allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");

await runtime.dispose();
process.exit(allPass ? 0 : 1);
