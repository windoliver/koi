/**
 * E2E test: Tag-Based Tool Profiles Through Full Koi Runtime.
 *
 * Validates the complete pipeline:
 *   YAML manifest with tool-selector middleware (tags/exclude)
 *   -> loadManifestFromString -> resolveAgent -> descriptor factory creates
 *   tag-based middleware -> tagged tools via ComponentProvider -> ModelRequest.tools
 *   -> tag filtering in middleware chain -> real LLM call -> full lifecycle
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run (from repo root):
 *   E2E_TESTS=1 bun test tests/e2e/tag-tool-profiles-e2e.test.ts
 *
 * Cost: ~$0.05 per run (haiku model, 5 tests).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  JsonObject,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { loadManifestFromString } from "@koi/manifest";
import { createAnthropicAdapter } from "@koi/model-router";
import { formatResolutionError, resolveAgent } from "../../packages/cli/src/resolve-agent.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/**
 * Extracts tool result strings from tool_call_end events.
 * Tool results are deterministic (from our mock tools), unlike LLM text output.
 */
function extractToolResults(events: readonly EngineEvent[]): readonly string[] {
  return events
    .filter(
      (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
    )
    .map((e) => String(e.result ?? ""));
}

function writeTempManifest(yaml: string): {
  readonly path: string;
  readonly dir: string;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "koi-e2e-tags-"));
  const path = join(dir, "koi.yaml");
  writeFileSync(path, yaml, "utf-8");
  return {
    path,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e: unknown) {
        console.warn("Failed to remove temp dir", dir, e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tagged tools — 4 tools across 3 tag categories
// ---------------------------------------------------------------------------

function createTaggedToolsProvider(): ComponentProvider {
  const addNumbers: Tool = {
    descriptor: {
      name: "add_numbers",
      description: "Adds two integers together and returns the sum.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "integer", description: "First number" },
          b: { type: "integer", description: "Second number" },
        },
        required: ["a", "b"],
      },
      tags: ["math", "coding"],
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const a = typeof args.a === "number" ? args.a : 0;
      const b = typeof args.b === "number" ? args.b : 0;
      return String(a + b);
    },
  };

  const multiplyNumbers: Tool = {
    descriptor: {
      name: "multiply_numbers",
      description: "Multiplies two integers together and returns the product.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "integer", description: "First number" },
          b: { type: "integer", description: "Second number" },
        },
        required: ["a", "b"],
      },
      tags: ["math", "coding"],
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const a = typeof args.a === "number" ? args.a : 0;
      const b = typeof args.b === "number" ? args.b : 0;
      return String(a * b);
    },
  };

  const webSearch: Tool = {
    descriptor: {
      name: "web_search",
      description: "Searches the web and returns a summary.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      tags: ["research"],
    },
    trustTier: "sandbox",
    execute: async () => "Search result: Koi is an agent engine framework.",
  };

  const deleteFile: Tool = {
    descriptor: {
      name: "delete_file",
      description: "Deletes a file from the filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete" },
        },
        required: ["path"],
      },
      tags: ["filesystem", "dangerous"],
    },
    trustTier: "sandbox",
    execute: async () => "File deleted successfully.",
  };

  return {
    name: "e2e-tagged-tools-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("add_numbers"), addNumbers);
      components.set(toolToken("multiply_numbers"), multiplyNumbers);
      components.set(toolToken("web_search"), webSearch);
      components.set(toolToken("delete_file"), deleteFile);
      return components;
    },
  };
}

/**
 * Creates a two-phase model handler:
 *   Phase 1: Returns a synthetic tool call (deterministic, no LLM cost).
 *            Captures request.tools for assertion.
 *   Phase 2: Uses real Anthropic API for the final answer.
 */
function createTwoPhaseModelHandler(syntheticToolCall: {
  readonly toolName: string;
  readonly callId: string;
  readonly input: JsonObject;
  readonly text: string;
}): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly getCapturedTools: () => readonly ToolDescriptor[];
} {
  // let: mutable counter for two-phase tracking
  let callCount = 0;
  // let: captures tools from the first model call for assertion
  let capturedTools: readonly ToolDescriptor[] = [];
  const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    if (callCount === 1) {
      // Capture tools the model received after middleware filtering
      capturedTools = request.tools ?? [];
      return {
        content: syntheticToolCall.text,
        model: E2E_MODEL,
        usage: { inputTokens: 10, outputTokens: 15 },
        metadata: {
          toolCalls: [
            {
              toolName: syntheticToolCall.toolName,
              callId: syntheticToolCall.callId,
              input: syntheticToolCall.input,
            },
          ],
        },
      };
    }
    return anthropic.complete({ ...request, model: E2E_MODEL, maxTokens: 100 });
  };

  return {
    modelCall,
    getCapturedTools: () => capturedTools,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: tag-based tool profiles through full Koi runtime", () => {
  // ── Test 1: Tag include ──────────────────────────────────────────────────

  test(
    "tags: [math] filters to only math-tagged tools through full stack",
    async () => {
      const yaml = `
name: e2e-tag-include
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [math]
      minTools: 0
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });
        expect(resolveResult.ok).toBe(true);
        if (!resolveResult.ok) throw new Error(formatResolutionError(resolveResult.error));
        const resolved = resolveResult.value;

        const provider = createTaggedToolsProvider();
        const handler = createTwoPhaseModelHandler({
          toolName: "add_numbers",
          callId: "call-tag-include",
          input: { a: 3, b: 4 },
          text: "I'll compute 3 + 4 using add_numbers.",
        });

        const adapter = createLoopAdapter({ modelCall: handler.modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
          providers: [provider],
        });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use the add_numbers tool to compute 3 + 4. Then tell me the result.",
            }),
          );

          // Assert: only math-tagged tools reached the model
          const capturedTools = handler.getCapturedTools();
          const toolNames = capturedTools.map((t) => t.name).sort();
          expect(toolNames).toEqual(["add_numbers", "multiply_numbers"]);

          // Assert: tool was called and returned correct result
          const toolResults = extractToolResults(events);
          expect(toolResults).toContain("7");

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          expect(output?.stopReason).toBe("completed");
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Tag exclude ──────────────────────────────────────────────────

  test(
    "exclude: [dangerous] removes dangerous-tagged tools through full stack",
    async () => {
      const yaml = `
name: e2e-tag-exclude
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      exclude: [dangerous]
      minTools: 0
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });
        expect(resolveResult.ok).toBe(true);
        if (!resolveResult.ok) throw new Error(formatResolutionError(resolveResult.error));
        const resolved = resolveResult.value;

        const provider = createTaggedToolsProvider();
        const handler = createTwoPhaseModelHandler({
          toolName: "add_numbers",
          callId: "call-tag-exclude",
          input: { a: 5, b: 3 },
          text: "I'll compute 5 + 3 using add_numbers.",
        });

        const adapter = createLoopAdapter({ modelCall: handler.modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
          providers: [provider],
        });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use the add_numbers tool to compute 5 + 3. Then tell me the result.",
            }),
          );

          // Assert: delete_file excluded, other 3 tools pass
          const capturedTools = handler.getCapturedTools();
          const toolNames = capturedTools.map((t) => t.name).sort();
          expect(toolNames).toEqual(["add_numbers", "multiply_numbers", "web_search"]);

          // Assert: tool result is deterministic (8 = 5 + 3)
          const toolResults = extractToolResults(events);
          expect(toolResults).toContain("8");

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          expect(output?.stopReason).toBe("completed");
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Combined tags + exclude ──────────────────────────────────────

  test(
    "tags: [coding] + exclude: [dangerous] filters to safe coding tools",
    async () => {
      const yaml = `
name: e2e-tag-combined
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [coding]
      exclude: [dangerous]
      minTools: 0
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });
        expect(resolveResult.ok).toBe(true);
        if (!resolveResult.ok) throw new Error(formatResolutionError(resolveResult.error));
        const resolved = resolveResult.value;

        const provider = createTaggedToolsProvider();
        const handler = createTwoPhaseModelHandler({
          toolName: "multiply_numbers",
          callId: "call-tag-combined",
          input: { a: 4, b: 5 },
          text: "I'll compute 4 * 5 using multiply_numbers.",
        });

        const adapter = createLoopAdapter({ modelCall: handler.modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
          providers: [provider],
        });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use the multiply_numbers tool to compute 4 * 5. Then tell me the result.",
            }),
          );

          // Assert: only add_numbers + multiply_numbers (coding & not dangerous)
          const capturedTools = handler.getCapturedTools();
          const toolNames = capturedTools.map((t) => t.name).sort();
          expect(toolNames).toEqual(["add_numbers", "multiply_numbers"]);

          // Assert: tool result is deterministic (20 = 4 * 5)
          const toolResults = extractToolResults(events);
          expect(toolResults).toContain("20");

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          expect(output?.stopReason).toBe("completed");
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: alwaysInclude overrides tag filter ───────────────────────────

  test(
    "alwaysInclude overrides tag filter to force-include tools",
    async () => {
      const yaml = `
name: e2e-tag-always-include
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [research]
      alwaysInclude: [add_numbers]
      minTools: 0
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });
        expect(resolveResult.ok).toBe(true);
        if (!resolveResult.ok) throw new Error(formatResolutionError(resolveResult.error));
        const resolved = resolveResult.value;

        const provider = createTaggedToolsProvider();
        const handler = createTwoPhaseModelHandler({
          toolName: "add_numbers",
          callId: "call-tag-always",
          input: { a: 10, b: 20 },
          text: "I'll compute 10 + 20 using add_numbers.",
        });

        const adapter = createLoopAdapter({ modelCall: handler.modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
          providers: [provider],
        });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use the add_numbers tool to compute 10 + 20. Then tell me the result.",
            }),
          );

          // Assert: web_search (matches research tag) + add_numbers (forced by alwaysInclude)
          const capturedTools = handler.getCapturedTools();
          const toolNames = capturedTools.map((t) => t.name).sort();
          expect(toolNames).toEqual(["add_numbers", "web_search"]);

          // Assert: tool result is deterministic (30 = 10 + 20)
          const toolResults = extractToolResults(events);
          expect(toolResults).toContain("30");

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          expect(output?.stopReason).toBe("completed");
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Pi adapter with tag filtering ────────────────────────────────

  test(
    "tag filtering works through pi adapter engine",
    async () => {
      const yaml = `
name: e2e-tag-pi-adapter
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [math]
      minTools: 0
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });
        expect(resolveResult.ok).toBe(true);
        if (!resolveResult.ok) throw new Error(formatResolutionError(resolveResult.error));
        const resolved = resolveResult.value;

        const provider = createTaggedToolsProvider();

        const adapter = createPiAdapter({
          model: `anthropic:${E2E_MODEL}`,
          systemPrompt:
            "You are a concise math assistant. When given tool results, report the answer.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
          providers: [provider],
        });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use add_numbers to compute 6 + 7. Report the result.",
            }),
          );

          // Pi adapter uses real LLM for all calls — we can't capture tools
          // the same way. Instead verify the runtime completed successfully
          // and the output contains the expected result.
          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          if (output === undefined) return;
          expect(output.stopReason).toBe("completed");
          expect(output.metrics.inputTokens).toBeGreaterThan(0);
          expect(output.metrics.outputTokens).toBeGreaterThan(0);

          const text = extractText(events);
          expect(text).toContain("13");
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
