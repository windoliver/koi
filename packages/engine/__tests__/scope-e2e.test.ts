/**
 * Comprehensive E2E test for scoped component views through the full
 * createKoi + createLoopAdapter runtime assembly.
 *
 * Uses a deterministic mock model handler that generates tool calls, ensuring
 * the full pipeline is exercised: assembly → tool descriptor injection →
 * model request → tool call → scoped backend → tool result → model response.
 *
 * The mock model handler inspects the `tools` array in the ModelRequest to
 * verify that tool descriptors are properly assembled and passed through.
 * It then emits tool_use content blocks that the loop adapter dispatches
 * to the scoped backends via createKoi's tool terminal.
 *
 * Additionally validates real Anthropic API calls for text-only flows to
 * confirm the runtime doesn't break with real LLM interaction.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 for the real-LLM tests.
 *
 * Run:
 *   bun test packages/engine/__tests__/scope-e2e.test.ts
 *   E2E_TESTS=1 bun test packages/engine/__tests__/scope-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
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
} from "@koi/core";
import { COMPONENT_PRIORITY, CREDENTIALS, FILESYSTEM, MEMORY } from "@koi/core";
import { createLoopAdapter } from "@koi/engine-loop";
import { createFileSystemProvider } from "@koi/filesystem";
import { createAnthropicAdapter } from "@koi/model-router";
import { createScopedCredentialsProvider, createScopedMemoryProvider } from "@koi/scope";
import { createKoi } from "../src/koi.js";

// ---------------------------------------------------------------------------
// Environment gate (for real-LLM tests only)
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeRealLLM = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

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

function extractToolCallEvents(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_start" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

// ---------------------------------------------------------------------------
// Mock model handler — deterministically generates tool calls
// ---------------------------------------------------------------------------

/**
 * Creates a model handler that:
 * - Turn 1: inspects available tools, calls the specified tool with given args
 * - Turn 2: responds with text summarizing the tool result
 *
 * This exercises the full pipeline without depending on real LLM tool use support.
 */
function createToolCallingModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
): (request: ModelRequest) => Promise<ModelResponse> {
  // let: tracks which turn we're on across calls
  let callCount = 0;

  return async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;

    if (callCount === 1) {
      // First call: emit a tool_use block
      return {
        content: "",
        model: "mock-tool-caller",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [
            {
              callId: `call_${callCount}`,
              toolName,
              input: toolArgs,
            },
          ],
        },
      };
    }

    // Subsequent calls: emit a text response summarizing what happened
    // The last message should be a tool result
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
      model: "mock-tool-caller",
      usage: { inputTokens: 15, outputTokens: 10 },
    };
  };
}

/**
 * Multi-tool model handler that calls tools in sequence.
 * Each entry in `calls` is { toolName, toolArgs }.
 * After all tool calls are made, it responds with text.
 */
function createMultiToolModel(
  calls: readonly { readonly toolName: string; readonly toolArgs: Record<string, unknown> }[],
): (request: ModelRequest) => Promise<ModelResponse> {
  // let: tracks which call we're on
  let callIndex = 0;

  return async (request: ModelRequest): Promise<ModelResponse> => {
    if (callIndex < calls.length) {
      const call = calls[callIndex];
      if (call === undefined) throw new Error("unreachable");
      callIndex++;
      return {
        content: "",
        model: "mock-multi-tool",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [
            { callId: `call_${callIndex}`, toolName: call.toolName, input: call.toolArgs },
          ],
        },
      };
    }

    // All tools called — summarize results
    const lastMsg = request.messages[request.messages.length - 1];
    const resultText =
      lastMsg !== undefined
        ? lastMsg.content
            .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
            .map((b) => b.text)
            .join("")
        : "no result";

    return {
      content: `Final: ${resultText}`,
      model: "mock-multi-tool",
      usage: { inputTokens: 15, outputTokens: 10 },
    };
  };
}

// ---------------------------------------------------------------------------
// Simple real filesystem backend (backed by Bun file I/O)
// ---------------------------------------------------------------------------

function createRealFileSystemBackend(name = "real-fs"): FileSystemBackend {
  return {
    name,
    read(filePath) {
      return Bun.file(filePath)
        .text()
        .then((content) => ({
          ok: true as const,
          value: { content, path: filePath, size: content.length },
        }))
        .catch((err: unknown) => ({
          ok: false as const,
          error: {
            code: "IO" as const,
            message: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        }));
    },
    write(filePath, content) {
      return Bun.write(filePath, content)
        .then((bytesWritten) => ({
          ok: true as const,
          value: { path: filePath, bytesWritten },
        }))
        .catch((err: unknown) => ({
          ok: false as const,
          error: {
            code: "IO" as const,
            message: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        }));
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
        } catch (err: unknown) {
          return {
            ok: false as const,
            error: {
              code: "IO" as const,
              message: `List failed: ${err instanceof Error ? err.message : String(err)}`,
              retryable: false,
            },
          };
        }
      })();
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
// In-memory memory component (with namespace tracking)
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
// Scoped Filesystem — deterministic tool-calling tests
// ---------------------------------------------------------------------------

describe("e2e: scoped filesystem through createKoi + createLoopAdapter", () => {
  test(
    "fs_read of in-scope file succeeds through full pipeline",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));
      const testFilePath = join(tmpDir, "hello.txt");
      await writeFile(testFilePath, "The secret number is 42.");

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "list"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createToolCallingModel("fs_read", { path: testFilePath });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-fs-read-e2e",
            version: "0.0.1",
            model: { name: "mock-tool-caller" },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Read the file." }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Model should have made a tool call
        const toolCalls = extractToolCallEvents(events);
        expect(toolCalls.length).toBe(1);
        expect(toolCalls[0]?.toolName).toBe("fs_read");

        // The final text should contain the file content
        const text = extractTextFromEvents(events);
        expect(text).toContain("secret number is 42");

        // Should have taken 2 turns (tool call + response)
        expect(output.metrics.turns).toBe(2);

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "fs_read of out-of-scope path returns permission error through pipeline",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        // Request a file outside the scope root
        const modelCall = createToolCallingModel("fs_read", { path: "/etc/hostname" });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-fs-escape-e2e",
            version: "0.0.1",
            model: { name: "mock-tool-caller" },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Read /etc/hostname." }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Tool call was made
        const toolCalls = extractToolCallEvents(events);
        expect(toolCalls.length).toBe(1);

        // The final text should contain the permission error from the scoped wrapper
        const text = extractTextFromEvents(events);
        expect(text).toContain("escapes root");

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "fs_write blocked in read-only mode through full pipeline",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "write"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const writeTarget = join(tmpDir, "test.txt");
        const modelCall = createToolCallingModel("fs_write", {
          path: writeTarget,
          content: "hello world",
        });
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-fs-readonly-e2e",
            version: "0.0.1",
            model: { name: "mock-tool-caller" },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Write a file." }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Tool call was made
        const toolCalls = extractToolCallEvents(events);
        expect(toolCalls.length).toBe(1);
        expect(toolCalls[0]?.toolName).toBe("fs_write");

        // Result should contain the read-only permission error
        const text = extractTextFromEvents(events);
        expect(text).toContain("read-only");

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "multi-tool: fs_list + fs_read through scoped pipeline",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));
      const dataFile = join(tmpDir, "data.json");
      await writeFile(dataFile, JSON.stringify({ value: 7 }));

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "list"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const modelCall = createMultiToolModel([
          { toolName: "fs_list", toolArgs: { path: tmpDir } },
          { toolName: "fs_read", toolArgs: { path: dataFile } },
        ]);
        const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-fs-multi-e2e",
            version: "0.0.1",
            model: { name: "mock-multi-tool" },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "List and read." }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");

        // Should have 2 tool calls
        const toolCalls = extractToolCallEvents(events);
        expect(toolCalls.length).toBe(2);
        expect(toolCalls[0]?.toolName).toBe("fs_list");
        expect(toolCalls[1]?.toolName).toBe("fs_read");

        // Final text should contain the file content (may be JSON-escaped)
        const text = extractTextFromEvents(events);
        expect(text).toContain("value");
        expect(text).toContain("7");

        // Should have 3 turns (list + read + final response)
        expect(output.metrics.turns).toBe(3);

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "tool descriptors are injected into ModelRequest",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read", "write", "list"],
          scope: { root: tmpDir, mode: "rw" },
        });

        // Capture the ModelRequest to inspect tool descriptors
        let capturedTools: readonly { readonly name: string }[] | undefined;

        const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
          capturedTools = request.tools;
          return {
            content: "Done",
            model: "mock-inspector",
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        };

        const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-fs-descriptors-e2e",
            version: "0.0.1",
            model: { name: "mock-inspector" },
          },
          adapter,
          providers: [fsProvider],
          loopDetection: false,
        });

        await collectEvents(runtime.run({ kind: "text", text: "Hello" }));

        // Tool descriptors should have been passed to the model
        expect(capturedTools).toBeDefined();
        if (capturedTools === undefined) return;

        const toolNames = capturedTools.map((t) => t.name);
        expect(toolNames).toContain("fs_read");
        expect(toolNames).toContain("fs_write");
        expect(toolNames).toContain("fs_list");

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Scoped Credentials — provider pipeline tests
// ---------------------------------------------------------------------------

describe("e2e: scoped credentials through provider pipeline", () => {
  test("pattern filters which keys are visible through attached provider", async () => {
    const allCredentials = createInMemoryCredentials({
      OPENAI_API_KEY: "sk-openai-123",
      OPENAI_ORG_ID: "org-456",
      STRIPE_SECRET_KEY: "sk-stripe-789",
      DATABASE_URL: "postgres://localhost/db",
    });

    const scopedProvider = createScopedCredentialsProvider(allCredentials, {
      keyPattern: "OPENAI_*",
    });

    const agent = {} as Parameters<typeof scopedProvider.attach>[0];
    const components = await scopedProvider.attach(agent);
    const scoped = components.get(CREDENTIALS as string) as CredentialComponent;

    expect(await scoped.get("OPENAI_API_KEY")).toBe("sk-openai-123");
    expect(await scoped.get("OPENAI_ORG_ID")).toBe("org-456");
    expect(await scoped.get("STRIPE_SECRET_KEY")).toBeUndefined();
    expect(await scoped.get("DATABASE_URL")).toBeUndefined();
  });

  test("exact-match pattern restricts to single key", async () => {
    const allCredentials = createInMemoryCredentials({
      MY_KEY: "secret",
      MY_KEY_2: "also-secret",
    });

    const scopedProvider = createScopedCredentialsProvider(allCredentials, {
      keyPattern: "MY_KEY",
    });

    const agent = {} as Parameters<typeof scopedProvider.attach>[0];
    const components = await scopedProvider.attach(agent);
    const scoped = components.get(CREDENTIALS as string) as CredentialComponent;

    expect(await scoped.get("MY_KEY")).toBe("secret");
    expect(await scoped.get("MY_KEY_2")).toBeUndefined();
  });

  test("provider uses AGENT_FORGED priority", () => {
    const creds = createInMemoryCredentials({});
    const provider = createScopedCredentialsProvider(creds, { keyPattern: "*" });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});

// ---------------------------------------------------------------------------
// Scoped Memory — namespace isolation through provider pipeline
// ---------------------------------------------------------------------------

describe("e2e: scoped memory namespace isolation", () => {
  test("two namespaces don't see each other's data through provider", async () => {
    const sharedBackend = createInMemoryMemory();

    const providerA = createScopedMemoryProvider(sharedBackend, { namespace: "agent-a" });
    const providerB = createScopedMemoryProvider(sharedBackend, { namespace: "agent-b" });

    const agentStub = {} as Parameters<typeof providerA.attach>[0];
    const componentsA = await providerA.attach(agentStub);
    const memoryA = componentsA.get(MEMORY as string) as MemoryComponent;
    const componentsB = await providerB.attach(agentStub);
    const memoryB = componentsB.get(MEMORY as string) as MemoryComponent;

    await memoryA.store("agent-a secret data");
    await memoryB.store("agent-b secret data");

    expect(sharedBackend.allStored).toHaveLength(2);

    const recallA = await memoryA.recall("data");
    expect(recallA.map((r) => r.content)).toContain("agent-a secret data");
    expect(recallA.map((r) => r.content)).not.toContain("agent-b secret data");

    const recallB = await memoryB.recall("data");
    expect(recallB.map((r) => r.content)).toContain("agent-b secret data");
    expect(recallB.map((r) => r.content)).not.toContain("agent-a secret data");
  });

  test("namespace is injected into store options", async () => {
    const sharedBackend = createInMemoryMemory();
    const provider = createScopedMemoryProvider(sharedBackend, { namespace: "test-ns" });

    const agentStub = {} as Parameters<typeof provider.attach>[0];
    const components = await provider.attach(agentStub);
    const memory = components.get(MEMORY as string) as MemoryComponent;

    await memory.store("hello");
    expect(sharedBackend.allStored).toHaveLength(1);

    const stored = sharedBackend.allStored[0];
    expect(stored).toBeDefined();
    expect(stored?.namespace).toBe("test-ns");
  });

  test("provider uses AGENT_FORGED priority", () => {
    const backend = createInMemoryMemory();
    const provider = createScopedMemoryProvider(backend, { namespace: "ns" });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline with governance — real LLM (gated)
// ---------------------------------------------------------------------------

describeRealLLM("e2e: scoped filesystem + real LLM + governance middleware", () => {
  test(
    "real LLM completes with scoped provider (no tools — text only validation)",
    async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "koi-scope-e2e-"));

      try {
        const backend = createRealFileSystemBackend();
        const fsProvider = createFileSystemProvider({
          backend,
          operations: ["read"],
          scope: { root: tmpDir, mode: "ro" },
        });

        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        const realModelCall = (request: ModelRequest) =>
          anthropic.complete({ ...request, model: "claude-haiku-4-5-20251001" });

        const adapter = createLoopAdapter({ modelCall: realModelCall, maxTurns: 3 });
        const runtime = await createKoi({
          manifest: {
            name: "scope-real-llm-e2e",
            version: "0.0.1",
            model: { name: "claude-haiku-4-5-20251001" },
          },
          adapter,
          providers: [fsProvider],
          governance: {
            iteration: { maxTurns: 10, maxTokens: 500_000, maxDurationMs: 120_000 },
          },
          loopDetection: false,
        });

        // Simple text prompt — validates the runtime assembles and runs
        // with a scoped provider attached (even though tools aren't used)
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        if (output === undefined) return;
        expect(output.stopReason).toBe("completed");
        expect(output.metrics.turns).toBe(1);
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);

        const text = extractTextFromEvents(events);
        expect(text.length).toBeGreaterThan(0);
        expect(text.toLowerCase()).toContain("hello");

        // Verify the filesystem component is attached and scoped
        const fs = runtime.agent.component<FileSystemBackend>(
          FILESYSTEM as import("@koi/core").SubsystemToken<FileSystemBackend>,
        );
        expect(fs).toBeDefined();
        expect(fs?.name).toContain("scoped");

        await runtime.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
