/**
 * End-to-end test for @koi/ralph with real LLM calls.
 *
 * Validates the full Ralph Loop through createKoi (L1) + createPiAdapter:
 *   - PRD items are iterated with real LLM generations
 *   - External verification gates objectively verify output
 *   - Learnings accumulate across iterations
 *   - Per-iteration metrics are recorded
 *   - AbortSignal / stop() / timeout work under real conditions
 *   - The full middleware chain is exercised
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 to avoid accidental API spend.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/ralph-e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentManifest, EngineEvent, EngineInput, KoiMiddleware } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import {
  createFileGate,
  createRalphLoop,
  createTestGate,
  readLearnings,
  readPRD,
} from "../index.js";
import type { GateContext, PRDFile, RunIterationFn } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 180_000;

const E2E_MANIFEST: AgentManifest = {
  name: "ralph-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let prdPath: string;
let learningsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-e2e-"));
  prdPath = join(tmpDir, "prd.json");
  learningsPath = join(tmpDir, "learnings.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Create a RunIterationFn that uses the full L1 pipeline:
 * createPiAdapter → createKoi → runtime.run()
 *
 * Each call creates a fresh runtime (clean context window),
 * which is the entire point of the Ralph Loop pattern.
 */
function createKoiRunner(middleware?: readonly KoiMiddleware[]): RunIterationFn {
  return (input: EngineInput): AsyncIterable<EngineEvent> => {
    // Return an async iterable that lazily creates the runtime
    return {
      [Symbol.asyncIterator]() {
        // Use let — justified: mutable state for lazy init and iterator protocol
        let runtime: Awaited<ReturnType<typeof createKoi>> | undefined;
        let innerIterator: AsyncIterator<EngineEvent> | undefined;

        return {
          async next() {
            // Lazy init: create fresh runtime on first call
            if (runtime === undefined) {
              const piAdapter = createPiAdapter({
                model: E2E_MODEL,
                systemPrompt: [
                  "You are a precise coding assistant.",
                  "When asked to write to a file, use the exact path given.",
                  "Always output the COMPLETE file content.",
                  "Do NOT use markdown code fences or any surrounding text.",
                  "Output ONLY the raw file content, nothing else.",
                ].join(" "),
                getApiKey: async () => ANTHROPIC_KEY,
              });

              runtime = await createKoi({
                manifest: E2E_MANIFEST,
                adapter: piAdapter,
                middleware: middleware ?? [],
                loopDetection: false,
                limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 10_000 },
              });

              innerIterator = runtime.run(input)[Symbol.asyncIterator]();
            }

            if (innerIterator === undefined) {
              return { done: true as const, value: undefined };
            }
            const result = await innerIterator.next();
            if (result.done) {
              // Dispose runtime after draining
              if (runtime !== undefined) {
                await runtime.dispose();
              }
              return { done: true as const, value: undefined };
            }
            return result;
          },
          async return() {
            if (runtime !== undefined) {
              await runtime.dispose();
            }
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  };
}

/**
 * Simpler RunIterationFn that writes a file based on LLM output.
 * The LLM is asked to produce specific content; we capture text_delta
 * events and write the accumulated text to a file.
 */
function createFileWriterRunner(outputDir: string): RunIterationFn {
  return (input: EngineInput): AsyncIterable<EngineEvent> => {
    return {
      [Symbol.asyncIterator]() {
        // Use let — justified: mutable state for lazy init, text accumulation, iterator protocol
        let runtime: Awaited<ReturnType<typeof createKoi>> | undefined;
        let innerIterator: AsyncIterator<EngineEvent> | undefined;
        let accumulatedText = "";
        let currentItemId: string | undefined;

        // Extract item ID from prompt
        if (input.kind === "text") {
          const match = /\[ITEM:(\S+)\]/.exec(input.text);
          currentItemId = match?.[1];
        }

        return {
          async next() {
            if (runtime === undefined) {
              const piAdapter = createPiAdapter({
                model: E2E_MODEL,
                systemPrompt: [
                  "You are a precise assistant.",
                  "When asked to produce content, output ONLY the requested content.",
                  "No explanations, no code fences, no surrounding text.",
                ].join(" "),
                getApiKey: async () => ANTHROPIC_KEY,
              });

              runtime = await createKoi({
                manifest: E2E_MANIFEST,
                adapter: piAdapter,
                middleware: [],
                loopDetection: false,
                limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 2_000 },
              });

              innerIterator = runtime.run(input)[Symbol.asyncIterator]();
            }

            if (innerIterator === undefined) {
              return { done: true as const, value: undefined };
            }
            const result = await innerIterator.next();
            if (result.done) {
              // Write accumulated text to file before disposing
              if (currentItemId && accumulatedText.trim().length > 0) {
                const outPath = join(outputDir, `${currentItemId}.txt`);
                await Bun.write(outPath, accumulatedText.trim());
              }
              if (runtime !== undefined) {
                await runtime.dispose();
              }
              return { done: true as const, value: undefined };
            }

            // Accumulate text deltas
            if (result.value.kind === "text_delta") {
              accumulatedText += result.value.delta;
            }

            return result;
          },
          async return() {
            if (runtime !== undefined) {
              await runtime.dispose();
            }
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: Ralph Loop with real Anthropic API via createKoi + createPiAdapter", () => {
  test(
    "completes a single PRD item with LLM + file gate",
    async () => {
      const outputDir = join(tmpDir, "output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [
          {
            id: "greeting",
            description: "Write a greeting message containing the word 'hello'",
            done: false,
          },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 3,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) =>
          [
            `[ITEM:${ctx.currentItem?.id}]`,
            `Write a short greeting message that contains the word "hello".`,
            `Output only the greeting text, nothing else.`,
          ].join("\n"),
        verify: createFileGate(join(outputDir, "greeting.txt"), /hello/i),
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e] iteration=${record.iteration} item=${record.itemId} ` +
              `passed=${String(record.gateResult.passed)} ` +
              `duration=${Math.round(record.durationMs)}ms` +
              (record.error ? ` error=${record.error}` : ""),
          );
        },
      });

      const result = await loop.run();

      console.log(
        `  [ralph-e2e] total: ${result.iterations} iterations, ` +
          `${result.completed.length} completed, ` +
          `${result.remaining.length} remaining, ` +
          `${Math.round(result.durationMs)}ms`,
      );

      // The LLM should produce "hello" in at most 3 iterations
      expect(result.completed).toContain("greeting");
      expect(result.remaining).toEqual([]);
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(result.iterations).toBeLessThanOrEqual(3);

      // Verify file was actually written
      const greetingFile = Bun.file(join(outputDir, "greeting.txt"));
      expect(await greetingFile.exists()).toBe(true);
      const content = await greetingFile.text();
      expect(content.toLowerCase()).toContain("hello");

      // Verify learnings were recorded
      const learnings = await readLearnings(learningsPath);
      expect(learnings.length).toBeGreaterThanOrEqual(1);

      // Verify PRD was updated
      const finalPrd = await readPRD(prdPath);
      expect(finalPrd.ok).toBe(true);
      if (finalPrd.ok) {
        const item = finalPrd.value.items.find((i) => i.id === "greeting");
        expect(item?.done).toBe(true);
        expect(item?.verifiedAt).toBeDefined();
      }

      // Verify iteration records have real metrics
      for (const record of result.iterationRecords) {
        expect(record.durationMs).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "completes multi-item PRD with composite gate",
    async () => {
      const outputDir = join(tmpDir, "multi-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [
          {
            id: "poem",
            description: "Write a two-line poem containing the word 'moon'",
            done: false,
          },
          {
            id: "fact",
            description: "Write a fact about water containing 'H2O'",
            done: false,
          },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 6,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => {
          const item = ctx.currentItem;
          if (!item) return "All items done.";

          const learningsSummary =
            ctx.learnings.length > 0
              ? `\nPrevious attempts:\n${ctx.learnings
                  .filter((l) => l.itemId === item.id)
                  .map(
                    (l) => `- ${l.failed.length > 0 ? `Failed: ${l.failed.join(", ")}` : "Passed"}`,
                  )
                  .join("\n")}`
              : "";

          return [
            `[ITEM:${item.id}]`,
            `Iteration ${ctx.iteration}/${ctx.totalIterations}.`,
            `Task: ${item.description}`,
            `Output only the requested content, nothing else.`,
            learningsSummary,
          ].join("\n");
        },
        verify: async (ctx) => {
          if (!ctx.currentItem) return { passed: false, details: "No current item" };
          const itemId = ctx.currentItem.id;
          const filePath = join(outputDir, `${itemId}.txt`);

          if (itemId === "poem") {
            return createFileGate(filePath, /moon/i)(ctx);
          }
          if (itemId === "fact") {
            return createFileGate(filePath, /H2O/i)(ctx);
          }
          return { passed: false, details: `Unknown item: ${itemId}` };
        },
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-multi] iteration=${record.iteration} item=${record.itemId} ` +
              `passed=${String(record.gateResult.passed)} ` +
              `duration=${Math.round(record.durationMs)}ms`,
          );
        },
      });

      const result = await loop.run();

      console.log(
        `  [ralph-e2e-multi] total: ${result.iterations} iterations, ` +
          `completed=[${result.completed.join(",")}], ` +
          `remaining=[${result.remaining.join(",")}]`,
      );

      expect(result.completed).toContain("poem");
      expect(result.completed).toContain("fact");
      expect(result.remaining).toEqual([]);

      // Verify files contain expected patterns
      const poemContent = await Bun.file(join(outputDir, "poem.txt")).text();
      expect(poemContent.toLowerCase()).toContain("moon");

      const factContent = await Bun.file(join(outputDir, "fact.txt")).text();
      expect(factContent).toContain("H2O");

      // Verify learnings accumulated
      const learnings = await readLearnings(learningsPath);
      expect(learnings.length).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  test(
    "onIteration callback fires with real timing data",
    async () => {
      const outputDir = join(tmpDir, "callback-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [{ id: "simple", description: "Say the word 'yes'", done: false }],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const observed: Array<{
        readonly iteration: number;
        readonly durationMs: number;
        readonly passed: boolean;
      }> = [];

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 3,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => `[ITEM:${ctx.currentItem?.id}]\nOutput exactly: yes`,
        verify: createFileGate(join(outputDir, "simple.txt"), /yes/i),
        onIteration: (record) => {
          observed.push({
            iteration: record.iteration,
            durationMs: record.durationMs,
            passed: record.gateResult.passed,
          });
        },
      });

      await loop.run();

      expect(observed.length).toBeGreaterThanOrEqual(1);
      // Real LLM call should take measurable time
      expect(observed[0]?.durationMs).toBeGreaterThan(100);
    },
    TIMEOUT_MS,
  );

  test(
    "stop() aborts loop during real LLM call",
    async () => {
      const outputDir = join(tmpDir, "stop-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [
          { id: "a", description: "Task A", done: false },
          { id: "b", description: "Task B", done: false },
          { id: "c", description: "Task C", done: false },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 10,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => `[ITEM:${ctx.currentItem?.id}]\nOutput: done`,
        verify: async (ctx) => {
          if (!ctx.currentItem) return { passed: false };
          const filePath = join(outputDir, `${ctx.currentItem.id}.txt`);
          const gate = createFileGate(filePath, /done/i);
          const result = await gate(ctx);
          // Stop after first successful iteration
          if (result.passed) {
            loop.stop();
          }
          return result;
        },
      });

      const result = await loop.run();

      // Should have stopped after 1 iteration, not continued to all 3
      expect(result.iterations).toBe(1);
      expect(result.completed.length).toBeLessThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  test(
    "exercises full middleware chain with observer",
    async () => {
      const outputDir = join(tmpDir, "mw-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [{ id: "mw-test", description: "Say 'middleware works'", done: false }],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      // Use let — justified: mutable counters for middleware observation
      let sessionStarts = 0;
      let sessionEnds = 0;

      const observerMw: KoiMiddleware = {
        name: "ralph-e2e-observer",
        async onSessionStart() {
          sessionStarts++;
        },
        async onSessionEnd() {
          sessionEnds++;
        },
      };

      const loop = createRalphLoop({
        runIteration: createKoiRunner([observerMw]),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 3,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (_ctx) => `Say exactly: middleware works`,
        // Always pass — we're testing middleware execution, not output verification
        verify: async () => ({ passed: true }),
      });

      const result = await loop.run();

      // Each iteration creates a fresh runtime → session starts/ends for each
      expect(sessionStarts).toBeGreaterThanOrEqual(1);
      expect(sessionEnds).toBeGreaterThanOrEqual(1);
      expect(result.completed).toContain("mw-test");
    },
    TIMEOUT_MS,
  );

  test(
    "test gate with real subprocess (bun test equivalent)",
    async () => {
      const outputDir = join(tmpDir, "gate-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      // Write a test file that the gate will check
      const testScript = join(tmpDir, "check.sh");
      await Bun.write(
        testScript,
        `#!/bin/sh\ntest -f "${join(outputDir, "result.txt")}" && grep -qi "answer" "${join(outputDir, "result.txt")}"`,
      );
      const { exited } = Bun.spawn(["chmod", "+x", testScript]);
      await exited;

      const prd: PRDFile = {
        items: [{ id: "result", description: "Write an answer", done: false }],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 3,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) =>
          `[ITEM:${ctx.currentItem?.id}]\nWrite a short sentence containing the word "answer".`,
        verify: createTestGate(["sh", testScript], { cwd: tmpDir }),
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-gate] iteration=${record.iteration} ` +
              `passed=${String(record.gateResult.passed)} ` +
              `details=${record.gateResult.details?.slice(0, 80) ?? "none"}`,
          );
        },
      });

      const result = await loop.run();

      expect(result.completed).toContain("result");

      // Verify the subprocess gate actually ran
      const passedRecords = result.iterationRecords.filter((r) => r.gateResult.passed);
      expect(passedRecords.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  test(
    "gate timeout: hanging gate is caught and recorded as failure",
    async () => {
      const outputDir = join(tmpDir, "gate-timeout-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [{ id: "timeout-item", description: "Say 'hello'", done: false }],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      // Use let — justified: mutable counter for gate calls
      let gateCalls = 0;

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 3,
        gateTimeoutMs: 500, // 500ms — gate will hang on first call
        maxConsecutiveFailures: 2,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => `[ITEM:${ctx.currentItem?.id}]\nOutput exactly: hello`,
        verify: async (ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            // First call: hang indefinitely — should be caught by gateTimeoutMs
            return new Promise<never>(() => {});
          }
          // Subsequent calls: check file normally
          if (!ctx.currentItem) return { passed: false };
          return createFileGate(join(outputDir, `${ctx.currentItem.id}.txt`), /hello/i)(ctx);
        },
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-gate-timeout] iteration=${record.iteration} ` +
              `item=${record.itemId} passed=${String(record.gateResult.passed)} ` +
              `details=${record.gateResult.details?.slice(0, 60) ?? "none"}`,
          );
        },
      });

      const result = await loop.run();

      console.log(
        `  [ralph-e2e-gate-timeout] total: ${result.iterations} iters, ` +
          `completed=[${result.completed.join(",")}], ` +
          `skipped=[${result.skipped.join(",")}]`,
      );

      // First iteration's gate should have timed out
      expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
      expect(result.iterationRecords[0]?.gateResult.details).toContain("Gate");

      // Item should eventually complete or be skipped (not hang forever)
      expect(result.iterations).toBeGreaterThanOrEqual(2);
      const finalState = [...result.completed, ...result.skipped];
      expect(finalState).toContain("timeout-item");

      // Total duration should be reasonable — not blocked by hanging gate
      expect(result.durationMs).toBeLessThan(120_000);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Gap-closing E2E tests: stuck-loop/skip, richer GateContext, priority
  // -------------------------------------------------------------------------

  test(
    "stuck-loop: skips item after maxConsecutiveFailures with real LLM",
    async () => {
      const outputDir = join(tmpDir, "skip-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      // Item "impossible" has a gate that will NEVER pass (requires "xyzzy42quantum")
      // Item "easy" has a gate that should pass (requires "hello")
      const prd: PRDFile = {
        items: [
          {
            id: "impossible",
            description: "Write a message containing 'hello'",
            done: false,
          },
          {
            id: "easy",
            description: "Write a greeting containing 'hello'",
            done: false,
          },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 10,
        maxConsecutiveFailures: 2,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => {
          const item = ctx.currentItem;
          if (!item) return "All done.";
          return [`[ITEM:${item.id}]`, `Write a short message containing the word "hello".`].join(
            "\n",
          );
        },
        verify: async (ctx) => {
          if (!ctx.currentItem) return { passed: false, details: "No current item" };
          const filePath = join(outputDir, `${ctx.currentItem.id}.txt`);

          if (ctx.currentItem.id === "impossible") {
            // Gate demands an impossible string — will always fail
            return createFileGate(filePath, "xyzzy42quantum")(ctx);
          }
          // "easy" item just needs "hello"
          return createFileGate(filePath, /hello/i)(ctx);
        },
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-skip] iteration=${record.iteration} item=${record.itemId} ` +
              `passed=${String(record.gateResult.passed)}`,
          );
        },
      });

      const result = await loop.run();

      console.log(
        `  [ralph-e2e-skip] total: ${result.iterations} iters, ` +
          `completed=[${result.completed.join(",")}], ` +
          `skipped=[${result.skipped.join(",")}], ` +
          `remaining=[${result.remaining.join(",")}]`,
      );

      // "impossible" should be skipped after 2 consecutive failures
      expect(result.skipped).toContain("impossible");
      // "easy" should complete (LLM produces "hello" easily)
      expect(result.completed).toContain("easy");
      expect(result.remaining).toEqual([]);

      // Verify PRD file reflects the skip
      const finalPrd = await readPRD(prdPath);
      if (finalPrd.ok) {
        const impossibleItem = finalPrd.value.items.find((i) => i.id === "impossible");
        expect(impossibleItem?.skipped).toBe(true);
        expect(impossibleItem?.done).toBe(false);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "richer GateContext: gate receives iteration history from real LLM runs",
    async () => {
      const outputDir = join(tmpDir, "ctx-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      const prd: PRDFile = {
        items: [
          { id: "first", description: "Say 'alpha'", done: false },
          { id: "second", description: "Say 'beta'", done: false },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      // Capture the full GateContext from each gate invocation
      const capturedContexts: GateContext[] = [];

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 4,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => {
          const item = ctx.currentItem;
          if (!item) return "Done.";
          return [
            `[ITEM:${item.id}]`,
            `Output the word "${item.id === "first" ? "alpha" : "beta"}" and nothing else.`,
          ].join("\n");
        },
        verify: async (ctx) => {
          capturedContexts.push(ctx);
          if (!ctx.currentItem) return { passed: false };
          const filePath = join(outputDir, `${ctx.currentItem.id}.txt`);

          if (ctx.currentItem.id === "first") {
            return createFileGate(filePath, /alpha/i)(ctx);
          }
          return createFileGate(filePath, /beta/i)(ctx);
        },
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-ctx] iteration=${record.iteration} item=${record.itemId} ` +
              `passed=${String(record.gateResult.passed)}`,
          );
        },
      });

      const result = await loop.run();

      // Should complete both items
      expect(result.completed).toContain("first");
      expect(result.completed).toContain("second");

      // Verify GateContext was enriched with real data
      expect(capturedContexts.length).toBeGreaterThanOrEqual(2);

      // First gate call: no history yet
      const firstCtx = capturedContexts[0];
      expect(firstCtx).toBeDefined();
      if (firstCtx) {
        expect(firstCtx.iterationRecords).toHaveLength(0);
        expect(firstCtx.remainingItems.length).toBeGreaterThanOrEqual(1);
        expect(firstCtx.workingDir).toBe(tmpDir);
      }

      // Second gate call: should have at least 1 iteration record from real LLM
      const secondCtx = capturedContexts.find((c) => c.iterationRecords.length > 0);
      expect(secondCtx).toBeDefined();
      if (secondCtx) {
        expect(secondCtx.iterationRecords.length).toBeGreaterThanOrEqual(1);
        // Real LLM call means durationMs should be substantial
        expect(secondCtx.iterationRecords[0]?.durationMs).toBeGreaterThan(100);
        // Learnings should have accumulated from first iteration
        expect(secondCtx.learnings.length).toBeGreaterThanOrEqual(1);
        // completedItems should include "first" if it passed
        const completedIds = secondCtx.completedItems.map((i) => i.id);
        expect(completedIds).toContain("first");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "priority ordering: higher-priority item processed first with real LLM",
    async () => {
      const outputDir = join(tmpDir, "priority-output");
      await Bun.write(join(outputDir, ".gitkeep"), "");

      // "urgent" has priority 1, "normal" has priority 10
      // Despite "normal" appearing first in the array, "urgent" should be processed first
      const prd: PRDFile = {
        items: [
          {
            id: "normal",
            description: "Say 'world'",
            done: false,
            priority: 10,
          },
          {
            id: "urgent",
            description: "Say 'hello'",
            done: false,
            priority: 1,
          },
        ],
      };
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const itemOrder: string[] = [];

      const loop = createRalphLoop({
        runIteration: createFileWriterRunner(outputDir),
        prdPath,
        learningsPath,
        workingDir: tmpDir,
        maxIterations: 4,
        iterationTimeoutMs: 60_000,
        iterationPrompt: (ctx) => {
          const item = ctx.currentItem;
          if (!item) return "Done.";
          // Track the order items are worked on
          itemOrder.push(item.id);
          const word = item.id === "urgent" ? "hello" : "world";
          return [`[ITEM:${item.id}]`, `Output exactly: ${word}`].join("\n");
        },
        verify: async (ctx) => {
          if (!ctx.currentItem) return { passed: false };
          const filePath = join(outputDir, `${ctx.currentItem.id}.txt`);

          if (ctx.currentItem.id === "urgent") {
            return createFileGate(filePath, /hello/i)(ctx);
          }
          return createFileGate(filePath, /world/i)(ctx);
        },
        onIteration: (record) => {
          console.log(
            `  [ralph-e2e-priority] iteration=${record.iteration} item=${record.itemId} ` +
              `passed=${String(record.gateResult.passed)}`,
          );
        },
      });

      const result = await loop.run();

      console.log(
        `  [ralph-e2e-priority] item order: [${itemOrder.join(", ")}], ` +
          `completed=[${result.completed.join(",")}]`,
      );

      // "urgent" (priority 1) should be processed before "normal" (priority 10)
      expect(itemOrder[0]).toBe("urgent");
      // Both should eventually complete
      expect(result.completed).toContain("urgent");
      expect(result.completed).toContain("normal");
      expect(result.remaining).toEqual([]);
      expect(result.skipped).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
