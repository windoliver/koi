/**
 * End-to-end test: Full Manifest Resolution -> createKoi Runtime with Real LLM.
 *
 * Validates the complete assembly pipeline:
 *   koi.yaml -> loadManifest() -> resolveAgent() -> createLoopAdapter/createPiAdapter
 *   -> createKoi() -> runtime.run() -> EngineEvent stream
 *
 * Tests exercise real Anthropic API calls through the full L1 runtime with
 * resolved middleware chains, tool execution, and engine adapters.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run (from repo root):
 *   E2E_TESTS=1 bun test tests/e2e/manifest-resolve-e2e.test.ts
 *
 * Cost: ~$0.01-0.02 per run (haiku model, minimal prompts).
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
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { loadManifestFromString } from "@koi/manifest";
import { createAnthropicAdapter } from "@koi/model-router";
import { formatResolutionError, resolveAgent } from "../../packages/meta/cli/src/resolve-agent.js";

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
 * Write a temporary koi.yaml manifest and return path + cleanup function.
 */
function writeTempManifest(yaml: string): {
  readonly path: string;
  readonly dir: string;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "koi-e2e-"));
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

/**
 * Creates an add_numbers tool with a ComponentProvider for entity attachment.
 */
function createAddNumbersProvider(): ComponentProvider {
  const tool: Tool = {
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
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const a = typeof args.a === "number" ? args.a : 0;
      const b = typeof args.b === "number" ? args.b : 0;
      return String(a + b);
    },
  };

  return {
    name: "e2e-add-numbers-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("add_numbers"), tool);
      return components;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: manifest resolution -> createKoi runtime", () => {
  // ── Test 1: Minimal manifest -> full assembly -> real LLM text response ──

  test(
    "minimal manifest -> resolveAgent -> createLoopAdapter -> createKoi -> real LLM response",
    async () => {
      const yaml = `
name: e2e-minimal
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
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

        const adapter = createLoopAdapter({ modelCall: resolved.model, maxTurns: 3 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
        });

        try {
          const events = await collectEvents(
            runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
          );

          const textDeltas = events.filter((e) => e.kind === "text_delta");
          expect(textDeltas.length).toBeGreaterThan(0);

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          if (output === undefined) return;
          expect(output.stopReason).toBe("completed");
          expect(output.metrics.inputTokens).toBeGreaterThan(0);
          expect(output.metrics.outputTokens).toBeGreaterThan(0);

          const text = extractText(events);
          expect(text.length).toBeGreaterThan(0);
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Soul + permissions middleware -> system prompt injection ──────

  test(
    "soul + permissions middleware resolved from manifest YAML",
    async () => {
      // Soul must be a string (inline text with newlines) or { path, maxTokens }.
      // Using multiline YAML literal block (|) so it's treated as inline text.
      const yaml = `
name: e2e-soul-permissions
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
soul: |
  You are a pirate who says arrr. Always speak like a pirate.
  Use pirate vocabulary like ahoy, matey, ye, and shiver me timbers.
permissions:
  allow: ["*"]
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

        // Both soul and permissions middleware should be resolved
        expect(resolved.middleware.length).toBeGreaterThanOrEqual(2);

        const adapter = createLoopAdapter({ modelCall: resolved.model, maxTurns: 3 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
        });

        try {
          const events = await collectEvents(
            runtime.run({ kind: "text", text: "Say hello and introduce yourself briefly." }),
          );

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          expect(output?.stopReason).toBe("completed");

          // Soul middleware injects pirate persona into system prompt.
          const text = extractText(events).toLowerCase();
          const hasPirateIndicator =
            text.includes("arrr") ||
            text.includes("ahoy") ||
            text.includes("matey") ||
            text.includes("pirate") ||
            text.includes("shiver");
          expect(hasPirateIndicator).toBe(true);
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Call-limits middleware -> enforced at runtime ─────────────────

  test(
    "call-limits middleware limits model calls to 1 turn",
    async () => {
      const yaml = `
name: e2e-call-limits
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-call-limits"
    options:
      maxModelCalls: 1
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

        const adapter = createLoopAdapter({ modelCall: resolved.model, maxTurns: 10 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
        });

        try {
          const events = await collectEvents(
            runtime.run({ kind: "text", text: "Tell me a story." }),
          );

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          if (output === undefined) return;

          // Call-limits middleware should enforce max 1 model call.
          expect(output.metrics.turns).toBeLessThanOrEqual(1);
        } finally {
          await runtime.dispose();
        }
      } finally {
        tmp.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Multiple middleware -> resolved and composed ─────────────────

  test(
    "multiple middleware resolved and composed from manifest",
    async () => {
      const yaml = `
name: e2e-multi-middleware
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-turn-ack"
  - name: "@koi/middleware-audit"
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

        // At least 2 middleware from the manifest
        expect(resolved.middleware.length).toBeGreaterThanOrEqual(2);

        const adapter = createLoopAdapter({ modelCall: resolved.model, maxTurns: 3 });
        const runtime = await createKoi({
          manifest,
          adapter,
          middleware: [...resolved.middleware],
        });

        try {
          const events = await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

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

  // ── Test 5: Tool call through full createKoi stack ──────────────────────

  test(
    "tool call executes through full createKoi stack with real LLM",
    async () => {
      const yaml = `
name: e2e-tool-call
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        const provider = createAddNumbersProvider();

        // Two-phase model handler: phase 1 returns a synthetic tool call,
        // phase 2 uses real LLM to generate the final answer.
        // This avoids needing tool descriptors in the loop adapter's ModelRequest.
        let callCount = 0; // mutable: tracks two-phase model handler phase
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        const twoPhaseModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
          callCount++;
          if (callCount === 1) {
            // Synthetic tool call — deterministic, no LLM cost.
            // metadata.toolCalls is the loop adapter's convention for tool calls.
            return {
              content: "I'll compute 3 + 4 using add_numbers.",
              model: E2E_MODEL,
              usage: { inputTokens: 10, outputTokens: 15 },
              metadata: {
                toolCalls: [
                  { toolName: "add_numbers", callId: "call-e2e-add", input: { a: 3, b: 4 } },
                ],
              },
            };
          }
          // Real LLM call for the final answer
          return anthropic.complete({ ...request, model: E2E_MODEL, maxTokens: 100 });
        };

        const adapter = createLoopAdapter({ modelCall: twoPhaseModelCall, maxTurns: 5 });
        const runtime = await createKoi({ manifest, adapter, providers: [provider] });

        try {
          const events = await collectEvents(
            runtime.run({
              kind: "text",
              text: "Use the add_numbers tool to compute 3 + 4. Then tell me the result.",
            }),
          );

          const toolStarts = events.filter((e) => e.kind === "tool_call_start");
          const toolEnds = events.filter((e) => e.kind === "tool_call_end");
          expect(toolStarts.length).toBeGreaterThanOrEqual(1);
          expect(toolEnds.length).toBeGreaterThanOrEqual(1);

          const text = extractText(events);
          expect(text).toContain("7");

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

  // ── Test 6: Resolution failure -> graceful error ────────────────────────

  test("resolution failure for nonexistent middleware returns descriptive error", async () => {
    const yaml = `
name: e2e-bad-middleware
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
middleware:
  - name: "@koi/middleware-nonexistent"
`;
    const tmp = writeTempManifest(yaml);
    try {
      const loadResult = loadManifestFromString(yaml);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      const { manifest } = loadResult.value;

      const resolveResult = await resolveAgent({ manifestPath: tmp.path, manifest });

      // Resolution must fail gracefully
      expect(resolveResult.ok).toBe(false);
      if (resolveResult.ok) return;

      // Error message should mention the nonexistent middleware
      const errorMsg = formatResolutionError(resolveResult.error);
      expect(errorMsg.toLowerCase()).toContain("nonexistent");
    } finally {
      tmp.cleanup();
    }
  });

  // ── Test 7: Pi adapter through createKoi ────────────────────────────────

  test(
    "pi adapter through full createKoi stack with real LLM",
    async () => {
      const yaml = `
name: e2e-pi-adapter
version: "0.0.1"
model:
  name: "anthropic:${E2E_MODEL}"
`;
      const tmp = writeTempManifest(yaml);
      try {
        const loadResult = loadManifestFromString(yaml);
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;
        const { manifest } = loadResult.value;

        // Pi adapter is an engine choice — created directly, not through resolve
        const adapter = createPiAdapter({
          model: `anthropic:${E2E_MODEL}`,
          systemPrompt: "You are a concise assistant. Reply briefly.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({ manifest, adapter });

        try {
          // createKoi auto-composes callHandlers from adapter.terminals
          // (pi adapter is cooperating mode — requires L1 to wire callHandlers)
          const events = await collectEvents(
            runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
          );

          const textDeltas = events.filter((e) => e.kind === "text_delta");
          expect(textDeltas.length).toBeGreaterThan(0);

          const output = findDoneOutput(events);
          expect(output).toBeDefined();
          if (output === undefined) return;
          expect(output.stopReason).toBe("completed");
          expect(output.metrics.inputTokens).toBeGreaterThan(0);
          expect(output.metrics.outputTokens).toBeGreaterThan(0);

          const text = extractText(events);
          expect(text.length).toBeGreaterThan(0);
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
