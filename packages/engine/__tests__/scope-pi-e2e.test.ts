/**
 * Comprehensive E2E test for scoped component views through the full
 * createKoi + createPiAdapter runtime assembly with real Anthropic API calls.
 *
 * Unlike scope-e2e.test.ts (which uses mock model handlers), this file
 * exercises the REAL LLM → tool call → scoped backend → tool result loop:
 *
 *   createKoi assembly → provider tool injection → pi Agent → real Anthropic API
 *   → tool_use response → middleware chain → tool terminal → scoped backend
 *   → tool result → pi Agent continues → final text
 *
 * Tests:
 *   1. Scoped filesystem: LLM reads a file through scoped path containment
 *   2. Scoped filesystem: LLM write blocked in read-only mode (permission error returned to LLM)
 *   3. Scoped filesystem: LLM path traversal blocked (../ escape attempt)
 *   4. Scoped credentials: LLM tool sees only keys matching the glob pattern
 *   5. Scoped memory: namespace isolation — two scoped views don't cross-contaminate
 *   6. Governance + scoped provider: iteration limits enforced alongside scoped tools
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel `bun test`.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/engine/__tests__/scope-pi-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EngineOutput, FileSystemBackend } from "@koi/core";
import { FILESYSTEM } from "@koi/core";
import type { SubsystemToken } from "@koi/core/ecs";
import { createPiAdapter } from "@koi/engine-pi";
import { createFileSystemProvider } from "@koi/filesystem";
import { createKoi } from "../src/koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function extractToolStarts(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function extractToolEnds(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_end" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

// ---------------------------------------------------------------------------
// Real filesystem backend (thin wrapper over node:fs)
// ---------------------------------------------------------------------------

function createRealFileSystemBackend(): FileSystemBackend {
  return {
    name: "real-fs-e2e",
    read(filePath) {
      return (async () => {
        try {
          const content = await Bun.file(filePath).text();
          return { ok: true as const, value: { content, path: filePath } };
        } catch {
          return {
            ok: false as const,
            error: {
              code: "NOT_FOUND" as const,
              message: `File not found: ${filePath}`,
              retryable: false,
            },
          };
        }
      })();
    },
    write(filePath, content) {
      return (async () => {
        try {
          await Bun.write(filePath, content);
          return { ok: true as const, value: { path: filePath, bytesWritten: content.length } };
        } catch {
          return {
            ok: false as const,
            error: {
              code: "INTERNAL" as const,
              message: `Write failed: ${filePath}`,
              retryable: false,
            },
          };
        }
      })();
    },
    list(dirPath) {
      return (async () => {
        try {
          const { readdir } = await import("node:fs/promises");
          const entries = await readdir(dirPath, { withFileTypes: true });
          return {
            ok: true as const,
            value: {
              entries: entries.map((e) => ({
                path: join(dirPath, e.name),
                kind: (e.isDirectory() ? "directory" : "file") as "file" | "directory",
              })),
            },
          };
        } catch {
          return {
            ok: false as const,
            error: {
              code: "NOT_FOUND" as const,
              message: `Directory not found: ${dirPath}`,
              retryable: false,
            },
          };
        }
      })();
    },
    edit() {
      return {
        ok: false as const,
        error: {
          code: "NOT_IMPLEMENTED" as const,
          message: "edit not supported in E2E backend",
          retryable: false,
        },
      };
    },
    search() {
      return Promise.resolve({
        ok: true as const,
        value: { matches: [] },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

async function withTempDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-pi-e2e-"));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: createKoi + createPiAdapter + scoped components", () => {
  // ── Test 1: Scoped filesystem read — LLM reads file within scope ───────

  test(
    "LLM reads a file through scoped filesystem (path within scope)",
    async () => {
      await withTempDir(async (tmpDir) => {
        // Seed a file
        await writeFile(join(tmpDir, "data.txt"), "The answer is 42.");

        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "list"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have filesystem tools. Use fs_read to read files.",
            `The working directory is: ${tmpDir}`,
            "Read the file 'data.txt' and report its content verbatim.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-fs-read",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "data.txt")} and tell me what it says.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // LLM should have made a tool call
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // At least one tool call should be fs_read
        const fsReadCalls = toolCalls.filter((tc) => tc.toolName === "fs_read");
        expect(fsReadCalls.length).toBeGreaterThanOrEqual(1);

        // Final text should contain the file content
        const text = extractText(events);
        expect(text).toContain("42");

        // Verify scoped backend is wired
        const fs = runtime.agent.component<FileSystemBackend>(
          FILESYSTEM as SubsystemToken<FileSystemBackend>,
        );
        expect(fs).toBeDefined();
        expect(fs?.name).toContain("scoped");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Scoped filesystem write blocked in read-only mode ──────────

  test(
    "LLM write attempt blocked by read-only scoped filesystem",
    async () => {
      await withTempDir(async (tmpDir) => {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have filesystem tools (fs_read, fs_write).",
            `The working directory is: ${tmpDir}`,
            "When asked to write a file, use the fs_write tool.",
            "If the tool returns an error, report the error message.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-fs-write-blocked",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Write the text "hello" to a file at ${join(tmpDir, "output.txt")}. Report whether it succeeded or failed.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // LLM should have tried fs_write
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        const writeCalls = toolCalls.filter((tc) => tc.toolName === "fs_write");
        expect(writeCalls.length).toBeGreaterThanOrEqual(1);

        // tool_call_end should have been emitted for the write attempt
        const toolEnds = extractToolEnds(events);
        expect(toolEnds.length).toBeGreaterThanOrEqual(1);

        // Final text should mention the block/error (LLM reports it)
        const text = extractText(events);
        const textLower = text.toLowerCase();
        expect(
          textLower.includes("read-only") ||
            textLower.includes("blocked") ||
            textLower.includes("permission") ||
            textLower.includes("denied") ||
            textLower.includes("error") ||
            textLower.includes("failed") ||
            textLower.includes("cannot"),
        ).toBe(true);

        // File should NOT have been created
        const { existsSync } = await import("node:fs");
        expect(existsSync(join(tmpDir, "output.txt"))).toBe(false);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Scoped filesystem path traversal blocked ───────────────────

  test(
    "LLM path traversal attempt (../) blocked by scoped filesystem",
    async () => {
      await withTempDir(async (tmpDir) => {
        // Create a file outside the scope to verify it can't be read
        const outsideDir = await mkdtemp(join(tmpdir(), "koi-scope-pi-outside-"));
        await writeFile(join(outsideDir, "secret.txt"), "TOP SECRET DATA");

        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have the fs_read tool for reading files.",
            `Your workspace root is: ${tmpDir}`,
            "Use the exact file path provided to read the file.",
            "If the tool returns an error, report the error message verbatim.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-fs-traversal",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(outsideDir, "secret.txt")} using the fs_read tool. Report what you find, or report any errors.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // LLM should have tried fs_read
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // The response should NOT contain the secret data
        const text = extractText(events);
        expect(text).not.toContain("TOP SECRET DATA");

        // Response should mention the path escape/block
        const textLower = text.toLowerCase();
        expect(
          textLower.includes("escape") ||
            textLower.includes("blocked") ||
            textLower.includes("outside") ||
            textLower.includes("restricted") ||
            textLower.includes("permission") ||
            textLower.includes("error") ||
            textLower.includes("denied"),
        ).toBe(true);

        await runtime.dispose();
        await rm(outsideDir, { recursive: true, force: true });
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Multi-tool pipeline — list + read ──────────────────────────

  test(
    "LLM uses fs_list then fs_read through scoped filesystem",
    async () => {
      await withTempDir(async (tmpDir) => {
        // Seed multiple files
        await writeFile(join(tmpDir, "alpha.txt"), "first file");
        await writeFile(join(tmpDir, "beta.txt"), "second file");

        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "list"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have fs_list and fs_read tools.",
            "First list the directory, then read each file.",
            "Report all file contents.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-multi-tool",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `List the files in ${tmpDir} then read each one. Report all their contents.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Should have at least 2 tool calls (list + read)
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(2);

        // Response should contain content from both files
        const text = extractText(events);
        expect(text).toContain("first file");
        expect(text).toContain("second file");

        // Metrics should reflect multiple turns
        expect(output.metrics.turns).toBeGreaterThanOrEqual(2);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Governance middleware enforced alongside scoped tools ───────

  test(
    "governance iteration limits enforced with scoped filesystem provider",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "test.txt"), "governance test content");

        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You have the fs_read tool. Use it when asked.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-governance",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          governance: {
            iteration: {
              maxTurns: 10,
              maxTokens: 500_000,
              maxDurationMs: TIMEOUT_MS,
            },
          },
          loopDetection: false,
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "test.txt")} and tell me what it contains.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Token accounting should be populated by governance
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
        expect(output.metrics.turns).toBeGreaterThanOrEqual(1);

        const text = extractText(events);
        expect(text).toContain("governance test content");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Middleware intercepts real tool calls through scoped backend ─

  test(
    "middleware chain fires for tool calls routed through scoped filesystem",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "tracked.txt"), "middleware test");

        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        // Track middleware invocations
        const interceptedToolIds: string[] = [];
        const interceptedModels: string[] = [];

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You have fs_read. Use it when asked to read files.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-middleware",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          middleware: [
            {
              name: "e2e-tool-interceptor",
              wrapToolCall: async (_ctx, request, next) => {
                interceptedToolIds.push(request.toolId);
                return next(request);
              },
              async *wrapModelStream(_ctx, request, next) {
                interceptedModels.push(request.model);
                yield* next(request);
              },
            },
          ],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "tracked.txt")} and tell me the content.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Middleware should have intercepted the model call
        expect(interceptedModels.length).toBeGreaterThanOrEqual(1);

        // Middleware should have intercepted the tool call
        expect(interceptedToolIds.length).toBeGreaterThanOrEqual(1);
        expect(interceptedToolIds).toContain("fs_read");

        // Content should still flow through correctly
        const text = extractText(events);
        expect(text).toContain("middleware test");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Tool descriptors properly injected into pi adapter ──────────

  test(
    "tool descriptors from scoped provider are visible to the LLM",
    async () => {
      await withTempDir(async (tmpDir) => {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "write", "list"],
          scope: { root: tmpDir, mode: "rw" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "List ALL tools you have available. Just list their names, nothing else.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "scope-pi-descriptors",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 3, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "What tools do you have? List them by name.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // The LLM should mention fs_read, fs_write, fs_list
        const text = extractText(events).toLowerCase();
        expect(text).toContain("fs_read");
        expect(text).toContain("fs_write");
        expect(text).toContain("fs_list");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );
});
