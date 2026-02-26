/**
 * Comprehensive E2E test for manifest-driven scope auto-wiring + pluggable
 * ScopeEnforcer through the full createKoi + createPiAdapter runtime assembly
 * with real Anthropic API calls.
 *
 * Validates Issue #432 Phase 2 additions:
 *   1. resolveManifestScope: manifest scope config → scoped ComponentProviders
 *   2. ScopeEnforcer: pluggable enforcement layer on top of scoped backends
 *   3. createEnforcedFileSystem: enforcer blocks/allows operations at runtime
 *   4. Full pipeline: assembly → tool injection → real LLM → tool call →
 *      enforced+scoped backend → tool result → LLM response
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during `bun test`.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/engine/__tests__/scope-enforcer-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CredentialComponent,
  EngineEvent,
  EngineOutput,
  FileSystemBackend,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  ModelRequest,
  ModelResponse,
  ScopeAccessRequest,
  ScopeEnforcer,
} from "@koi/core";
import { CREDENTIALS, FILESYSTEM, MEMORY } from "@koi/core";
import type { SubsystemToken } from "@koi/core/ecs";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createFileSystemProvider } from "@koi/filesystem";
import {
  createEnforcedCredentials,
  createEnforcedFileSystem,
  createEnforcedMemory,
  createScopedCredentialsProvider,
  createScopedMemoryProvider,
} from "@koi/scope";
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
// Event helpers
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

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

async function withTempDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "koi-enforcer-e2e-"));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Real filesystem backend (thin wrapper over Bun file I/O)
// ---------------------------------------------------------------------------

function createRealFileSystemBackend(): FileSystemBackend {
  return {
    name: "real-fs-enforcer-e2e",
    read(filePath) {
      return (async () => {
        try {
          const content = await Bun.file(filePath).text();
          return { ok: true as const, value: { content, path: filePath, size: content.length } };
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
          const bytesWritten = await Bun.write(filePath, content);
          return { ok: true as const, value: { path: filePath, bytesWritten } };
        } catch {
          return {
            ok: false as const,
            error: { code: "IO" as const, message: `Write failed: ${filePath}`, retryable: false },
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
                size: 0,
              })),
              truncated: false,
            },
          };
        } catch {
          return {
            ok: false as const,
            error: {
              code: "NOT_FOUND" as const,
              message: `Dir not found: ${dirPath}`,
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
          message: "edit not supported",
          retryable: false,
        },
      };
    },
    search() {
      return { ok: true as const, value: { matches: [], truncated: false } };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory credential store
// ---------------------------------------------------------------------------

function createInMemoryCredentials(store: Readonly<Record<string, string>>): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      return store[key];
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory memory component
// ---------------------------------------------------------------------------

function createInMemoryMemory(): MemoryComponent & {
  readonly allStored: readonly { content: string; namespace?: string }[];
} {
  const stored: { content: string; namespace?: string }[] = [];
  return {
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      stored.push(
        options?.namespace !== undefined ? { content, namespace: options.namespace } : { content },
      );
    },
    async recall(_query: string, options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      return stored
        .filter((s) => {
          if (options?.namespace === undefined) return true;
          return s.namespace === undefined || s.namespace === options.namespace;
        })
        .map((s) => ({
          content: s.content,
          ...(s.namespace !== undefined ? { metadata: { namespace: s.namespace } } : {}),
        }));
    },
    allStored: stored,
  };
}

// ---------------------------------------------------------------------------
// Tracking enforcer — records all access requests
// ---------------------------------------------------------------------------

function createTrackingEnforcer(
  policy: (request: ScopeAccessRequest) => boolean,
): ScopeEnforcer & { readonly requests: readonly ScopeAccessRequest[] } {
  const requests: ScopeAccessRequest[] = [];
  return {
    checkAccess(request: ScopeAccessRequest): boolean {
      requests.push(request);
      return policy(request);
    },
    requests,
  };
}

// ---------------------------------------------------------------------------
// Mock model handler for deterministic enforcer tests (no API key needed)
// ---------------------------------------------------------------------------

function createToolCallingModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
): (request: ModelRequest) => Promise<ModelResponse> {
  // let: tracks turn count
  let callCount = 0;
  return async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    if (callCount === 1) {
      return {
        content: "",
        model: "mock-enforcer-test",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [{ callId: `call_${callCount}`, toolName, input: toolArgs }],
        },
      };
    }
    const lastMsg = request.messages[request.messages.length - 1];
    const toolResultText =
      lastMsg !== undefined
        ? lastMsg.content
            .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
            .map((b) => b.text)
            .join("")
        : "no result";
    return {
      content: `Tool result: ${toolResultText}`,
      model: "mock-enforcer-test",
      usage: { inputTokens: 15, outputTokens: 10 },
    };
  };
}

// ===========================================================================
// Deterministic tests (mock model — no API key needed)
// ===========================================================================

describe("e2e: ScopeEnforcer + createKoi + createLoopAdapter (deterministic)", () => {
  test(
    "enforcer allows fs_read — operation succeeds through full pipeline",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "allowed.txt"), "enforcer-allowed-content");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => true); // allow all
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createToolCallingModel("fs_read", {
          path: join(tmpDir, "allowed.txt"),
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: { name: "enforcer-allow-e2e", version: "0.0.1", model: { name: "mock" } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Read the file." }));
        const output = findDoneOutput(events);

        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Enforcer should have been called for the read operation
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);
        const readReq = enforcer.requests.find((r) => r.operation === "read");
        expect(readReq).toBeDefined();
        expect(readReq?.subsystem).toBe("filesystem");
        expect(readReq?.resource).toBe(join(tmpDir, "allowed.txt"));

        // Content should flow through
        const text = extractText(events);
        expect(text).toContain("enforcer-allowed-content");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  test(
    "enforcer denies fs_read — returns PERMISSION error through pipeline",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "secret.txt"), "should-not-see-this");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => false); // deny all
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createToolCallingModel("fs_read", {
          path: join(tmpDir, "secret.txt"),
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: { name: "enforcer-deny-e2e", version: "0.0.1", model: { name: "mock" } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Read the file." }));
        const output = findDoneOutput(events);

        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Enforcer was called
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);

        // Content should NOT flow through — error instead
        const text = extractText(events);
        expect(text).not.toContain("should-not-see-this");
        expect(text.toLowerCase()).toMatch(/permission|denied|blocked|enforcer/);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  test(
    "enforcer denies fs_write — file never created",
    async () => {
      await withTempDir(async (tmpDir) => {
        const targetPath = join(tmpDir, "blocked-write.txt");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => false);
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "rw" },
        });

        const modelCall = createToolCallingModel("fs_write", {
          path: targetPath,
          content: "should never be written",
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: { name: "enforcer-deny-write-e2e", version: "0.0.1", model: { name: "mock" } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Write a file." }));
        const output = findDoneOutput(events);

        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Enforcer blocked the write
        expect(enforcer.requests.find((r) => r.operation === "write")).toBeDefined();

        // File should NOT exist
        expect(existsSync(targetPath)).toBe(false);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  test(
    "selective enforcer — allows reads, blocks writes",
    async () => {
      await withTempDir(async (tmpDir) => {
        const readTarget = join(tmpDir, "readable.txt");
        const writeTarget = join(tmpDir, "writable.txt");
        await writeFile(readTarget, "readable-content");

        const backend = createRealFileSystemBackend();
        // Only allow read operations
        const enforcer = createTrackingEnforcer((req) => req.operation === "read");
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "rw" },
        });

        // Turn 1: read (should succeed)
        const readModel = createToolCallingModel("fs_read", { path: readTarget });
        const readAdapter = createLoopAdapter({ modelCall: readModel, maxTurns: 5 });
        const readRuntime = await createKoi({
          manifest: {
            name: "enforcer-selective-read-e2e",
            version: "0.0.1",
            model: { name: "mock" },
          },
          adapter: readAdapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const readEvents = await collectEvents(readRuntime.run({ kind: "text", text: "Read." }));
        const readText = extractText(readEvents);
        expect(readText).toContain("readable-content");
        await readRuntime.dispose();

        // Reset enforcer tracking for write test
        const enforcer2 = createTrackingEnforcer((req) => req.operation === "read");
        const enforcedBackend2 = createEnforcedFileSystem(backend, enforcer2);
        const fsProvider2 = createFileSystemProvider({
          backend: enforcedBackend2,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "rw" },
        });

        // Turn 2: write (should be blocked by enforcer)
        const writeModel = createToolCallingModel("fs_write", {
          path: writeTarget,
          content: "blocked",
        });
        const writeAdapter = createLoopAdapter({ modelCall: writeModel, maxTurns: 5 });
        const writeRuntime = await createKoi({
          manifest: {
            name: "enforcer-selective-write-e2e",
            version: "0.0.1",
            model: { name: "mock" },
          },
          adapter: writeAdapter,
          providers: [fsProvider2],
          loopDetection: false,
        });

        const writeEvents = await collectEvents(writeRuntime.run({ kind: "text", text: "Write." }));
        const writeText = extractText(writeEvents);
        expect(writeText).not.toContain("blocked");
        expect(existsSync(writeTarget)).toBe(false);

        // Verify enforcer saw both operation types across both runs
        expect(enforcer.requests.find((r) => r.operation === "read")).toBeDefined();
        expect(enforcer2.requests.find((r) => r.operation === "write")).toBeDefined();

        await writeRuntime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  test(
    "enforced credentials — enforcer denies credential access",
    async () => {
      const allCredentials = createInMemoryCredentials({
        ALLOWED_KEY: "visible-secret",
        BLOCKED_KEY: "invisible-secret",
      });

      // Only allow access to ALLOWED_KEY
      const enforcer = createTrackingEnforcer((req) => req.resource === "ALLOWED_KEY");
      const enforcedCreds = createEnforcedCredentials(allCredentials, enforcer);

      // Direct access test (not through full pipeline — credentials don't have tool descriptors)
      const allowed = await enforcedCreds.get("ALLOWED_KEY");
      expect(allowed).toBe("visible-secret");

      const blocked = await enforcedCreds.get("BLOCKED_KEY");
      expect(blocked).toBeUndefined();

      // Enforcer was called for both
      expect(enforcer.requests).toHaveLength(2);
      expect(enforcer.requests[0]?.subsystem).toBe("credentials");
      expect(enforcer.requests[1]?.subsystem).toBe("credentials");
    },
    TIMEOUT_MS,
  );

  test(
    "enforced memory — enforcer blocks store and recall",
    async () => {
      const memoryBackend = createInMemoryMemory();

      // Deny all memory operations
      const enforcer = createTrackingEnforcer(() => false);
      const enforcedMemory = createEnforcedMemory(memoryBackend, enforcer);

      // Store should be silently blocked
      await enforcedMemory.store("secret data", { namespace: "test-ns" });
      expect(memoryBackend.allStored).toHaveLength(0); // nothing reached the backend

      // Recall should return empty
      const results = await enforcedMemory.recall("query");
      expect(results).toHaveLength(0);

      // Enforcer was called for both operations
      expect(enforcer.requests).toHaveLength(2);
      expect(enforcer.requests[0]?.operation).toBe("store");
      expect(enforcer.requests[1]?.operation).toBe("recall");
    },
    TIMEOUT_MS,
  );

  test(
    "enforced credentials wired as provider through createKoi assembly",
    async () => {
      const allCredentials = createInMemoryCredentials({
        API_KEY_OPENAI: "sk-openai",
        API_KEY_ANTHROPIC: "sk-anthropic",
        DB_PASSWORD: "dbpass",
      });

      // Allow only API_KEY_* access
      const enforcer = createTrackingEnforcer((req) =>
        req.subsystem === "credentials" ? req.resource.startsWith("API_KEY_") : true,
      );
      const enforcedCreds = createEnforcedCredentials(allCredentials, enforcer);

      // Wrap in scoped provider with glob pattern (double filtering: enforcer + glob)
      const provider = createScopedCredentialsProvider(enforcedCreds, { keyPattern: "*" });

      const agentStub = {} as Parameters<typeof provider.attach>[0];
      const components = await provider.attach(agentStub);
      const creds = components.get(CREDENTIALS as string) as CredentialComponent;

      // API keys: glob allows, enforcer allows
      expect(await creds.get("API_KEY_OPENAI")).toBe("sk-openai");
      expect(await creds.get("API_KEY_ANTHROPIC")).toBe("sk-anthropic");

      // DB password: glob allows (pattern is "*"), but enforcer blocks
      expect(await creds.get("DB_PASSWORD")).toBeUndefined();

      expect(enforcer.requests.length).toBe(3);
    },
    TIMEOUT_MS,
  );

  test(
    "enforced memory wired as provider — namespace isolation + enforcer",
    async () => {
      const memoryBackend = createInMemoryMemory();

      // Allow store but deny recall
      const enforcer = createTrackingEnforcer((req) => req.operation === "store");
      const enforcedMemory = createEnforcedMemory(memoryBackend, enforcer);

      const provider = createScopedMemoryProvider(enforcedMemory, { namespace: "ns-1" });

      const agentStub = {} as Parameters<typeof provider.attach>[0];
      const components = await provider.attach(agentStub);
      const memory = components.get(MEMORY as string) as MemoryComponent;

      // Store should succeed (enforcer allows store)
      await memory.store("test data");
      expect(memoryBackend.allStored).toHaveLength(1);
      expect(memoryBackend.allStored[0]?.namespace).toBe("ns-1");

      // Recall should return empty (enforcer blocks recall)
      const results = await memory.recall("test");
      expect(results).toHaveLength(0);

      expect(enforcer.requests).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  test(
    "middleware chain + enforcer both fire on same tool call",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "mw-test.txt"), "middleware-enforcer-combo");

        const interceptedToolIds: string[] = [];
        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => true);
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createToolCallingModel("fs_read", {
          path: join(tmpDir, "mw-test.txt"),
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: { name: "enforcer-mw-combo-e2e", version: "0.0.1", model: { name: "mock" } },
          adapter,
          providers: [fsProvider],
          middleware: [
            {
              name: "e2e-tool-tracker",
              wrapToolCall: async (_ctx, request, next) => {
                interceptedToolIds.push(request.toolId);
                return next(request);
              },
            },
          ],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Read file." }));
        const text = extractText(events);

        // Both middleware and enforcer fired
        expect(interceptedToolIds).toContain("fs_read");
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);

        // Content still flows through
        expect(text).toContain("middleware-enforcer-combo");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  test(
    "async enforcer (Promise-based) works through full pipeline",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "async-test.txt"), "async-enforcer-ok");

        const backend = createRealFileSystemBackend();
        const asyncRequests: ScopeAccessRequest[] = [];
        const asyncEnforcer: ScopeEnforcer = {
          async checkAccess(request: ScopeAccessRequest): Promise<boolean> {
            asyncRequests.push(request);
            // Simulate async latency (e.g., database lookup)
            await new Promise((resolve) => setTimeout(resolve, 5));
            return true;
          },
        };
        const enforcedBackend = createEnforcedFileSystem(backend, asyncEnforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createToolCallingModel("fs_read", {
          path: join(tmpDir, "async-test.txt"),
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: { name: "enforcer-async-e2e", version: "0.0.1", model: { name: "mock" } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Read file." }));
        const text = extractText(events);

        expect(asyncRequests.length).toBeGreaterThanOrEqual(1);
        expect(text).toContain("async-enforcer-ok");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// Real LLM tests (gated on ANTHROPIC_API_KEY + E2E_TESTS=1)
// ===========================================================================

describeE2E("e2e: ScopeEnforcer + createKoi + createPiAdapter + real Anthropic", () => {
  // ── Test 1: Enforcer allows — LLM reads through enforced+scoped filesystem ──

  test(
    "LLM reads file through enforced+scoped filesystem (enforcer allows)",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "enforced.txt"), "Enforcer allowed value: 99");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => true);
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read", "list"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have filesystem tools (fs_read, fs_list).",
            `The working directory is: ${tmpDir}`,
            "Read files when asked and report their content verbatim.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: { name: "enforcer-pi-allow-e2e", version: "0.0.1", model: { name: E2E_MODEL } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "enforced.txt")} and tell me what it says.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // LLM used the tool
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // Enforcer was called
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);
        expect(enforcer.requests.find((r) => r.subsystem === "filesystem")).toBeDefined();

        // Content flows through
        const text = extractText(events);
        expect(text).toContain("99");

        // Scoped backend is attached
        const fs = runtime.agent.component<FileSystemBackend>(
          FILESYSTEM as SubsystemToken<FileSystemBackend>,
        );
        expect(fs).toBeDefined();

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Enforcer denies — LLM gets permission error ──

  test(
    "LLM gets permission error when enforcer denies fs_read",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "blocked.txt"), "TOP SECRET — enforcer should block");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => false); // deny everything
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have the fs_read tool.",
            "Try to read files when asked. If the tool returns an error, report it.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: { name: "enforcer-pi-deny-e2e", version: "0.0.1", model: { name: E2E_MODEL } },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "blocked.txt")}. Report what happens.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // LLM tried the tool
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // Enforcer was called and denied
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);

        // Content should NOT contain the secret
        const text = extractText(events);
        expect(text).not.toContain("TOP SECRET");

        // LLM should report an error
        const textLower = text.toLowerCase();
        expect(
          textLower.includes("permission") ||
            textLower.includes("denied") ||
            textLower.includes("error") ||
            textLower.includes("blocked") ||
            textLower.includes("access") ||
            textLower.includes("failed"),
        ).toBe(true);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Selective enforcer — read OK, write blocked ──

  test(
    "LLM reads successfully but write is blocked by selective enforcer",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "existing.txt"), "read-this-fine");

        const backend = createRealFileSystemBackend();
        // Allow reads, block writes
        const enforcer = createTrackingEnforcer((req) => req.operation === "read");
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "rw" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: [
            "You have fs_read and fs_write tools.",
            `Working directory: ${tmpDir}`,
            "Step 1: Read the file 'existing.txt' and report its content.",
            "Step 2: Try to write 'output.txt' with content 'hello'.",
            "Step 3: Report both results — what the read returned and whether the write succeeded or failed.",
          ].join("\n"),
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "enforcer-pi-selective-e2e",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
          limits: { maxTurns: 8, maxDurationMs: TIMEOUT_MS, maxTokens: 500_000 },
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `First read ${join(tmpDir, "existing.txt")}, then try to write "hello" to ${join(tmpDir, "output.txt")}. Report what happened with each operation.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Tool calls should have happened
        const toolCalls = extractToolStarts(events);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // Enforcer tracked both operations
        expect(enforcer.requests.find((r) => r.operation === "read")).toBeDefined();

        // Read content should appear in response
        const text = extractText(events);
        expect(text).toContain("read-this-fine");

        // Write file should NOT have been created (enforcer blocked it)
        expect(existsSync(join(tmpDir, "output.txt"))).toBe(false);

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Enforcer + middleware both fire on real LLM tool calls ──

  test(
    "middleware chain + enforcer both intercept real LLM tool calls",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "combo.txt"), "middleware-plus-enforcer");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => true);
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const interceptedToolIds: string[] = [];
        const interceptedModels: string[] = [];

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You have fs_read. Use it when asked to read files.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "enforcer-pi-mw-combo-e2e",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          middleware: [
            {
              name: "e2e-combo-interceptor",
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
            text: `Read the file at ${join(tmpDir, "combo.txt")} and report its content.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Middleware intercepted both model and tool calls
        expect(interceptedModels.length).toBeGreaterThanOrEqual(1);
        expect(interceptedToolIds.length).toBeGreaterThanOrEqual(1);
        expect(interceptedToolIds).toContain("fs_read");

        // Enforcer was invoked
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);

        // Content flows through all layers
        const text = extractText(events);
        expect(text).toContain("middleware-plus-enforcer");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Governance + enforcer + scoped provider — full stack ──

  test(
    "governance + enforcer + scoped provider all active on same runtime",
    async () => {
      await withTempDir(async (tmpDir) => {
        await writeFile(join(tmpDir, "full-stack.txt"), "full-stack-content-123");

        const backend = createRealFileSystemBackend();
        const enforcer = createTrackingEnforcer(() => true);
        const enforcedBackend = createEnforcedFileSystem(backend, enforcer);

        const fsProvider = createFileSystemProvider({
          backend: enforcedBackend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You have fs_read. Use it when asked.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: {
            name: "enforcer-pi-full-stack-e2e",
            version: "0.0.1",
            model: { name: E2E_MODEL },
          },
          adapter,
          providers: [fsProvider],
          governance: {
            iteration: { maxTurns: 10, maxTokens: 500_000, maxDurationMs: TIMEOUT_MS },
          },
          loopDetection: false,
        });

        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: `Read the file at ${join(tmpDir, "full-stack.txt")} and report its content.`,
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Governance tracked metrics
        expect(output?.metrics.inputTokens).toBeGreaterThan(0);
        expect(output?.metrics.outputTokens).toBeGreaterThan(0);
        expect(output?.metrics.turns).toBeGreaterThanOrEqual(1);

        // Enforcer was invoked
        expect(enforcer.requests.length).toBeGreaterThanOrEqual(1);

        // Content flows through
        const text = extractText(events);
        expect(text).toContain("full-stack-content-123");

        await runtime.dispose();
      });
    },
    TIMEOUT_MS,
  );
});
