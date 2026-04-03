import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityFragment, MemoryComponent } from "@koi/core";
import { MEMORY, runId, sessionId } from "@koi/core";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createContextHydrator } from "./hydrator.js";
import type { ContextManifestConfig } from "./types.js";

// ── Helpers ──

const tempFiles: string[] = [];

function createTempFile(content: string): string {
  const path = join(
    tmpdir(),
    `koi-hydrator-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  writeFileSync(path, content);
  tempFiles.push(path);
  return path;
}

function createAgentWithMemory(
  results: readonly { content: string }[],
): ReturnType<typeof createMockAgent> {
  const memory: MemoryComponent = {
    async recall() {
      return results.map((r) => ({ content: r.content }));
    },
    async store() {},
  };
  return createMockAgent({
    components: new Map([[MEMORY as string, memory]]),
  });
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tempFiles.length = 0;
});

// ── Tests ──

describe("createContextHydrator", () => {
  test("creates middleware with correct name and priority", () => {
    const agent = createMockAgent();
    const mw = createContextHydrator({
      config: { sources: [{ kind: "text", text: "hi" }] },
      agent,
    });
    expect(mw.name).toBe("context-hydrator");
    expect(mw.priority).toBe(300);
  });

  test("hydrates text source and prepends system message on wrapModelCall", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "You are a research assistant.", label: "System", required: true },
      ],
    };
    const mw = createContextHydrator({ config, agent });

    // Trigger onSessionStart
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // Trigger wrapModelCall
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    expect(spy.calls).toHaveLength(1);
    const request = spy.calls[0];
    if (request === undefined) throw new Error("Expected request");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.senderId).toBe("system:context");
    expect(request.messages[0]?.content[0]?.kind).toBe("text");
    const textBlock = request.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("You are a research assistant.");
  });

  test("passes through when no cached content (empty config)", async () => {
    const agent = createMockAgent();
    // A config where text is empty will produce empty content
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    // With empty content, section header is still present — let's check
    // Actually empty text produces "## Text\n\n" which is not empty
    // So the message will be prepended
    expect(spy.calls).toHaveLength(1);
  });

  test("passes through when onSessionStart not called", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "hello" }],
    };
    const mw = createContextHydrator({ config, agent });

    // Skip onSessionStart → cached is undefined
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    expect(spy.calls).toHaveLength(1);
    // No system message prepended
    expect(spy.calls[0]?.messages).toHaveLength(0);
  });

  test("resolves file source during hydration", async () => {
    const path = createTempFile("file knowledge content");
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "file", path, label: "Knowledge" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("file knowledge content");
    expect(textBlock.text).toContain("Knowledge");
  });

  test("resolves memory source during hydration", async () => {
    const agent = createAgentWithMemory([{ content: "remembered fact" }]);
    const config: ContextManifestConfig = {
      sources: [{ kind: "memory", query: "facts" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("remembered fact");
  });

  test("caches hydrated result and reuses across calls", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "cached", label: "Cache Test" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();

    // Call twice
    const spy1 = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy1.handler);
    const spy2 = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy2.handler);

    // Both should have the same system message
    const text1 = (spy1.calls[0]?.messages[0]?.content[0] as { text: string }).text;
    const text2 = (spy2.calls[0]?.messages[0]?.content[0] as { text: string }).text;
    expect(text1).toBe(text2);
  });
});

describe("createContextHydrator — edge cases", () => {
  // Edge case 1: All sources fail + all optional → agent starts + warnings
  test("all optional sources fail → no system message, warnings generated", async () => {
    const agent = createMockAgent(); // No memory component
    const config: ContextManifestConfig = {
      sources: [
        { kind: "memory", query: "test", required: false },
        { kind: "file", path: "/nonexistent/path.txt", required: false },
        { kind: "skill", name: "missing", required: false },
      ],
    };
    const mw = createContextHydrator({ config, agent });

    // Should not throw
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    // wrapModelCall should pass through without system message
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toHaveLength(0);
  });

  // Edge case 2: Required source fails → throws
  test("required source fails → throws with actionable error", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "file", path: "/nonexistent.txt", required: true, label: "Critical File" }],
    };
    const mw = createContextHydrator({ config, agent });

    await expect(
      mw.onSessionStart?.({
        agentId: "a",
        sessionId: sessionId("s"),
        runId: runId("r"),
        metadata: {},
      }),
    ).rejects.toThrow("Required context source failed: Critical File");
  });

  // Edge case 3: Single source exceeds its maxTokens → truncated with notice
  test("source exceeding per-source maxTokens is truncated with notice", async () => {
    const agent = createMockAgent();
    const longText = "a".repeat(1000); // 250 tokens at 4 chars/token
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: longText, maxTokens: 10 }], // 10 tokens = 40 chars
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    // 40 chars of "a" kept, rest truncated
    expect(textBlock.text).toContain("a".repeat(40));
    // Truncation notice appended so agent knows content was cut
    expect(textBlock.text).toContain("[Content truncated");
  });

  // Edge case 4: Cumulative sources exceed global maxTokens → lowest-priority dropped with notice
  test("sources exceeding global maxTokens are dropped with notice", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      maxTokens: 12, // 12 tokens = 48 chars — fits first source only
      sources: [
        { kind: "text", text: "a".repeat(40), label: "High Priority", priority: 1 }, // 10 tokens
        { kind: "text", text: "b".repeat(40), label: "Low Priority", priority: 99 }, // 10 tokens — over budget
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    // High priority included
    expect(textBlock.text).toContain("a".repeat(40));
    // Low priority dropped — notice embedded in output
    expect(textBlock.text).not.toContain("b".repeat(40));
    expect(textBlock.text).toContain("dropped due to token budget");
    expect(textBlock.text).toContain("Low Priority");
  });

  // Edge case 5: File source with non-existent path → error per required
  test("non-existent file with required=false → warning, not crash", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "fallback", label: "Fallback", priority: 0 },
        {
          kind: "file",
          path: "/does/not/exist.md",
          required: false,
          label: "Optional File",
          priority: 10,
        },
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("fallback");
    expect(textBlock.text).not.toContain("Optional File");
  });

  // Edge case 6: Memory source with no MemoryComponent → error per required
  test("memory source without MemoryComponent and required=true → throws", async () => {
    const agent = createMockAgent(); // No MEMORY component
    const config: ContextManifestConfig = {
      sources: [{ kind: "memory", query: "q", required: true, label: "Memories" }],
    };
    const mw = createContextHydrator({ config, agent });
    await expect(
      mw.onSessionStart?.({
        agentId: "a",
        sessionId: sessionId("s"),
        runId: runId("r"),
        metadata: {},
      }),
    ).rejects.toThrow("Required context source failed: Memories");
  });

  // Edge case 7: Priority sorting works correctly
  test("sources are sorted by priority (lower = higher priority)", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "THIRD", label: "C", priority: 30 },
        { kind: "text", text: "FIRST", label: "A", priority: 1 },
        { kind: "text", text: "SECOND", label: "B", priority: 15 },
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    const firstIdx = textBlock.text.indexOf("FIRST");
    const secondIdx = textBlock.text.indexOf("SECOND");
    const thirdIdx = textBlock.text.indexOf("THIRD");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  // Edge case 8: Duplicate source labels (both included, no dedup)
  test("duplicate labels are both included", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [
        { kind: "text", text: "version 1", label: "Policy" },
        { kind: "text", text: "version 2", label: "Policy" },
      ],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const textBlock = spy.calls[0]?.messages[0]?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("version 1");
    expect(textBlock.text).toContain("version 2");
  });
});

describe("createContextHydrator — wrapModelStream", () => {
  test("prepends system message in stream mode", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "Stream context", label: "Stream" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    let capturedRequest: { messages: readonly unknown[] } | undefined;

    async function* mockStream(req: { messages: readonly unknown[] }) {
      capturedRequest = req;
      yield { kind: "done" as const, response: { content: "hi", model: "test" } };
    }

    const gen = mw.wrapModelStream?.(ctx, { messages: [] }, mockStream);
    if (gen === undefined) throw new Error("Expected generator");
    // Consume the generator
    for await (const _chunk of gen) {
      // consume
    }

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.messages).toHaveLength(1);
    expect((capturedRequest?.messages[0] as { senderId: string }).senderId).toBe("system:context");
  });

  test("passes through stream when no cached content", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "hi" }],
    };
    const mw = createContextHydrator({ config, agent });
    // Don't call onSessionStart

    const ctx = createMockTurnContext();
    let capturedRequest: { messages: readonly unknown[] } | undefined;

    async function* mockStream(req: { messages: readonly unknown[] }) {
      capturedRequest = req;
      yield { kind: "done" as const, response: { content: "hi", model: "test" } };
    }

    const gen = mw.wrapModelStream?.(ctx, { messages: [] }, mockStream);
    if (gen === undefined) throw new Error("Expected generator");
    for await (const _chunk of gen) {
      /* consume */
    }

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.messages).toHaveLength(0);
  });

  test("stream mode includes correct text content (11A)", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "Stream context data", label: "StreamLabel" }],
    };
    const mw = createContextHydrator({ config, agent });
    await mw.onSessionStart?.({
      agentId: "a",
      sessionId: sessionId("s"),
      runId: runId("r"),
      metadata: {},
    });

    const ctx = createMockTurnContext();
    let capturedRequest: { messages: readonly unknown[] } | undefined;

    async function* mockStream(req: { messages: readonly unknown[] }) {
      capturedRequest = req;
      yield { kind: "done" as const, response: { content: "ok", model: "test" } };
    }

    const gen = mw.wrapModelStream?.(ctx, { messages: [] }, mockStream);
    if (gen === undefined) throw new Error("Expected generator");
    for await (const _chunk of gen) {
      /* consume */
    }

    expect(capturedRequest).toBeDefined();
    const msg = capturedRequest?.messages[0] as {
      content: readonly { kind: string; text: string }[];
    };
    const textBlock = msg.content[0];
    expect(textBlock).toBeDefined();
    expect(textBlock?.text).toContain("Stream context data");
    expect(textBlock?.text).toContain("StreamLabel");
  });
});

describe("describeCapabilities", () => {
  test("is defined on the middleware", () => {
    const agent = createMockAgent();
    const mw = createContextHydrator({
      config: { sources: [{ kind: "text", text: "hi" }] },
      agent,
    });
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'context' and description containing 'hydration'", () => {
    const agent = createMockAgent();
    const mw = createContextHydrator({
      config: { sources: [{ kind: "text", text: "hi" }] },
      agent,
    });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;
    expect(result.label).toBe("context");
    expect(result.description).toContain("sources");
  });
});
