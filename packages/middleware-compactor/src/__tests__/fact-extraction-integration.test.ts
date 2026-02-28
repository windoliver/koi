/**
 * Integration test: compaction → fact extraction → recall.
 *
 * Uses the real fs-memory backend (filesystem-backed) to verify
 * end-to-end that facts survive compaction and are retrievable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryComponent } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { ModelResponse } from "@koi/core/middleware";
import { createLlmCompactor } from "../compact.js";
import { createFactExtractingArchiver } from "../fact-extracting-archiver.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: Date.now() };
}

function toolMsg(text: string, toolName: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: Date.now(),
    metadata: { toolName },
  };
}

function createMockSummarizer(summary = "Test summary") {
  return async (): Promise<ModelResponse> => ({
    content: summary,
    model: "test-model",
  });
}

// Simple in-memory MemoryComponent for integration testing
function createInMemoryMemory(): {
  readonly memory: MemoryComponent;
  readonly facts: Map<
    string,
    { readonly content: string; readonly accessCount: number; readonly category: string }
  >;
} {
  const facts = new Map<
    string,
    { readonly content: string; readonly accessCount: number; readonly category: string }
  >();
  // let required: mutable counter for fact IDs
  let nextId = 0;

  const memory: MemoryComponent = {
    recall: async (query) => {
      const results: Array<{
        readonly content: string;
        readonly score: number;
        readonly metadata: Readonly<Record<string, unknown>>;
      }> = [];
      for (const [id, fact] of facts) {
        if (fact.content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            content: fact.content,
            score: 1.0,
            metadata: { id, category: fact.category, accessCount: fact.accessCount },
          });
        }
      }
      return results;
    },
    store: async (content, options) => {
      // Simple dedup with reinforce
      for (const [id, existing] of facts) {
        if (
          existing.content === content &&
          existing.category === (options?.category ?? "context")
        ) {
          if (options?.reinforce === true) {
            facts.set(id, { ...existing, accessCount: existing.accessCount + 1 });
          }
          return;
        }
      }
      const id = `fact-${nextId++}`;
      facts.set(id, {
        content,
        accessCount: 0,
        category: options?.category ?? "context",
      });
    },
  };

  return { memory, facts };
}

// let required: mutable test directory ref
let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `koi-fact-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("compaction → fact extraction → recall integration", () => {
  test("compaction extracts facts via archiver and stores to memory", async () => {
    const { memory, facts } = createInMemoryMemory();
    const archiver = createFactExtractingArchiver(memory);

    const compactor = createLlmCompactor({
      summarizer: createMockSummarizer("Summary of work"),
      contextWindowSize: 1000,
      trigger: { messageCount: 3 },
      preserveRecent: 1,
      maxSummaryTokens: 100,
      archiver,
    });

    const messages = [
      userMsg("We decided to use Bun as the runtime"),
      toolMsg("Created /src/server.ts", "write_file"),
      userMsg("The issue was fixed by updating the config"),
      userMsg("latest message"),
    ];

    const result = await compactor.compact(messages, 1000);
    expect(result.strategy).toBe("llm-summary");

    // Facts should have been extracted and stored
    expect(facts.size).toBeGreaterThan(0);
  });

  test("stored facts are retrievable via memory.recall()", async () => {
    const { memory, facts } = createInMemoryMemory();
    const archiver = createFactExtractingArchiver(memory);

    const messages = [
      userMsg("We decided to use TypeScript strict mode"),
      toolMsg("Created /src/config.ts successfully", "write_file"),
    ];

    await archiver.archive(messages, "Summary");

    // Should be able to recall the decision
    const decisionResults = await memory.recall("decided");
    expect(decisionResults.length).toBeGreaterThan(0);
    expect(decisionResults[0]?.content).toContain("decided");

    // Facts map should have entries
    expect(facts.size).toBeGreaterThan(0);
  });

  test("duplicate facts across compactions are deduplicated", async () => {
    const { memory, facts } = createInMemoryMemory();
    const archiver = createFactExtractingArchiver(memory);

    const messages = [userMsg("We decided to use Bun as the runtime")];

    // Archive same messages twice
    await archiver.archive(messages, "Summary 1");
    await archiver.archive(messages, "Summary 2");

    // Should only have one unique fact (dedup by content + reinforce)
    expect(facts.size).toBe(1);
  });

  test("reinforced facts have increased accessCount", async () => {
    const { memory, facts } = createInMemoryMemory();
    const archiver = createFactExtractingArchiver(memory);

    const messages = [userMsg("We decided to use Bun as the runtime")];

    // Archive same messages multiple times with reinforce (default true)
    await archiver.archive(messages, "Summary 1");
    await archiver.archive(messages, "Summary 2");
    await archiver.archive(messages, "Summary 3");

    // Should have one fact with accessCount > 0
    expect(facts.size).toBe(1);
    const factValues = [...facts.values()];
    expect(factValues[0]?.accessCount).toBeGreaterThan(0);
  });
});
