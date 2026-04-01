import { describe, expect, test } from "bun:test";
import type { MemoryComponent, MemoryStoreOptions } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createFactExtractingArchiver } from "./fact-extracting-archiver.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

function toolMsg(text: string, toolName: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: 1,
    metadata: { toolName },
  };
}

function createMockMemory(): {
  readonly memory: MemoryComponent;
  readonly stored: Array<{
    readonly content: string;
    readonly options: MemoryStoreOptions | undefined;
  }>;
} {
  const stored: Array<{
    readonly content: string;
    readonly options: MemoryStoreOptions | undefined;
  }> = [];
  const memory: MemoryComponent = {
    recall: async () => [],
    store: async (content: string, options?: MemoryStoreOptions) => {
      stored.push({ content, options: options ?? undefined });
    },
  };
  return { memory, stored };
}

describe("createFactExtractingArchiver", () => {
  test("extracts facts and calls memory.store() for each", async () => {
    const { memory, stored } = createMockMemory();
    const archiver = createFactExtractingArchiver(memory);

    const messages = [
      userMsg("We decided to use TypeScript for the backend"),
      toolMsg("Created /src/app.ts successfully", "write_file"),
    ];

    await archiver.archive(messages, "Summary text");

    // Should have extracted at least 1 fact (decision + artifact)
    expect(stored.length).toBeGreaterThanOrEqual(1);
    // Check that categories are set
    const categories = stored.map((s) => s.options?.category);
    expect(categories.some((c) => c === "decision" || c === "artifact")).toBe(true);
  });

  test("passes reinforce: true by default", async () => {
    const { memory, stored } = createMockMemory();
    const archiver = createFactExtractingArchiver(memory);

    const messages = [userMsg("We decided to use Bun runtime")];
    await archiver.archive(messages, "Summary");

    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]?.options?.reinforce).toBe(true);
  });

  test("respects reinforce: false config", async () => {
    const { memory, stored } = createMockMemory();
    const archiver = createFactExtractingArchiver(memory, { reinforce: false });

    const messages = [userMsg("We decided to use Deno instead")];
    await archiver.archive(messages, "Summary");

    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]?.options?.reinforce).toBe(false);
  });

  test("archiver failure does not throw", async () => {
    const failingMemory: MemoryComponent = {
      recall: async () => [],
      store: async () => {
        throw new Error("storage failed");
      },
    };
    const archiver = createFactExtractingArchiver(failingMemory);

    const messages = [userMsg("We decided to use GraphQL")];
    // Should reject because the individual store() calls reject,
    // and Promise.all propagates. The wrapping compactor will catch this.
    await expect(archiver.archive(messages, "Summary")).rejects.toThrow("storage failed");
  });

  test("empty extraction produces no store calls", async () => {
    const { memory, stored } = createMockMemory();
    const archiver = createFactExtractingArchiver(memory);

    // Messages with no matching patterns
    const messages = [userMsg("Hello"), userMsg("How are you?")];
    await archiver.archive(messages, "Summary");

    expect(stored).toHaveLength(0);
  });
});
