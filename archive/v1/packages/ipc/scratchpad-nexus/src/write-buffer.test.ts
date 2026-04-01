/**
 * Tests for createWriteBuffer — buffering, coalescing, and flush behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  KoiError,
  Result,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadGeneration,
  ScratchpadWriteResult,
} from "@koi/core";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
import { MAX_BUFFER_SIZE } from "./constants.js";
import type { ScratchpadClient } from "./scratchpad-client.js";
import type { BufferedWrite } from "./write-buffer.js";
import { createWriteBuffer } from "./write-buffer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_GROUP_ID = agentGroupId("test-group");
const TEST_AUTHOR_ID = agentId("test-author");

function createMockClient(): ScratchpadClient {
  return {
    write: mock(
      (): Promise<Result<ScratchpadWriteResult, KoiError>> =>
        Promise.resolve({
          ok: true,
          value: {
            path: scratchpadPath("test"),
            generation: 1 as ScratchpadGeneration,
            sizeBytes: 4,
          },
        }),
    ),
    read: mock(
      (): Promise<Result<ScratchpadEntry, KoiError>> =>
        Promise.resolve({
          ok: true,
          value: {
            path: scratchpadPath("test"),
            content: "data",
            generation: 1 as ScratchpadGeneration,
            groupId: TEST_GROUP_ID,
            authorId: TEST_AUTHOR_ID,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sizeBytes: 4,
          },
        }),
    ),
    generation: mock(
      (): Promise<Result<ScratchpadGeneration, KoiError>> =>
        Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
    ),
    list: mock(
      (): Promise<Result<readonly ScratchpadEntrySummary[], KoiError>> =>
        Promise.resolve({ ok: true, value: [] }),
    ),
    delete: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
    provision: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
  };
}

function makeWrite(path: string, content: string, expectedGeneration?: number): BufferedWrite {
  return {
    path: scratchpadPath(path),
    content,
    ...(expectedGeneration !== undefined
      ? { expectedGeneration: expectedGeneration as ScratchpadGeneration }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWriteBuffer", () => {
  let mockClient: ScratchpadClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  // -------------------------------------------------------------------------
  // Basic buffer operations
  // -------------------------------------------------------------------------

  describe("add", () => {
    test("stores write in buffer", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);
      const write = makeWrite("notes/plan.md", "hello");

      await buffer.add(write);

      expect(buffer.has(scratchpadPath("notes/plan.md"))).toBe(true);
      expect(buffer.get(scratchpadPath("notes/plan.md"))).toEqual(write);
      expect(buffer.size()).toBe(1);
    });

    test("returns optimistic result with incremented generation", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);
      const write = makeWrite("data.json", "content", 3);

      const result = await buffer.add(write);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.path).toBe(scratchpadPath("data.json"));
        expect(result.value.generation).toBe(4);
        expect(result.value.sizeBytes).toBe(new TextEncoder().encode("content").byteLength);
      }
    });

    test("returns generation 1 when no expectedGeneration is provided", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);
      const write = makeWrite("new.txt", "data");

      const result = await buffer.add(write);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.generation).toBe(1);
      }
    });

    test("forces flush when buffer reaches MAX_BUFFER_SIZE", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      // Fill buffer to MAX_BUFFER_SIZE
      for (let i = 0; i < MAX_BUFFER_SIZE; i++) {
        await buffer.add(makeWrite(`file-${String(i)}.txt`, `content-${String(i)}`));
      }

      // Buffer should have been flushed — client.write called for all entries
      expect(mockClient.write).toHaveBeenCalledTimes(MAX_BUFFER_SIZE);
      expect(buffer.size()).toBe(0);
    });

    test("does not flush when buffer is below MAX_BUFFER_SIZE", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      for (let i = 0; i < MAX_BUFFER_SIZE - 1; i++) {
        await buffer.add(makeWrite(`file-${String(i)}.txt`, `content-${String(i)}`));
      }

      expect(mockClient.write).not.toHaveBeenCalled();
      expect(buffer.size()).toBe(MAX_BUFFER_SIZE - 1);
    });
  });

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  describe("flush", () => {
    test("sends all buffered writes to client", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      await buffer.add(makeWrite("a.txt", "content-a"));
      await buffer.add(makeWrite("b.txt", "content-b"));
      await buffer.add(makeWrite("c.txt", "content-c"));

      await buffer.flush();

      expect(mockClient.write).toHaveBeenCalledTimes(3);
    });

    test("clears the buffer after flush", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      await buffer.add(makeWrite("a.txt", "content-a"));
      await buffer.add(makeWrite("b.txt", "content-b"));

      await buffer.flush();

      expect(buffer.size()).toBe(0);
      expect(buffer.has(scratchpadPath("a.txt"))).toBe(false);
      expect(buffer.has(scratchpadPath("b.txt"))).toBe(false);
    });

    test("is a no-op when buffer is empty", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      await buffer.flush();

      expect(mockClient.write).not.toHaveBeenCalled();
    });

    test("passes correct arguments to client.write", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      await buffer.add({
        path: scratchpadPath("notes/plan.md"),
        content: "hello world",
        expectedGeneration: 2 as ScratchpadGeneration,
        ttlSeconds: 3600,
        metadata: { tag: "plan" },
      });

      await buffer.flush();

      expect(mockClient.write).toHaveBeenCalledWith(
        TEST_GROUP_ID,
        TEST_AUTHOR_ID,
        scratchpadPath("notes/plan.md"),
        "hello world",
        2,
        3600,
        { tag: "plan" },
      );
    });
  });

  // -------------------------------------------------------------------------
  // has / get
  // -------------------------------------------------------------------------

  describe("has/get", () => {
    test("returns false/undefined for paths not in buffer", () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      expect(buffer.has(scratchpadPath("missing.txt"))).toBe(false);
      expect(buffer.get(scratchpadPath("missing.txt"))).toBeUndefined();
    });

    test("returns true/entry for paths in buffer", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);
      const write = makeWrite("present.txt", "data");

      await buffer.add(write);

      expect(buffer.has(scratchpadPath("present.txt"))).toBe(true);
      expect(buffer.get(scratchpadPath("present.txt"))).toEqual(write);
    });
  });

  // -------------------------------------------------------------------------
  // Coalescing
  // -------------------------------------------------------------------------

  describe("coalescing", () => {
    test("multiple writes to same path coalesce to last-write-wins", async () => {
      const buffer = createWriteBuffer(mockClient, TEST_GROUP_ID, TEST_AUTHOR_ID);

      await buffer.add(makeWrite("shared.txt", "first"));
      await buffer.add(makeWrite("shared.txt", "second"));
      await buffer.add(makeWrite("shared.txt", "third"));

      expect(buffer.size()).toBe(1);

      const entry = buffer.get(scratchpadPath("shared.txt"));
      expect(entry?.content).toBe("third");

      await buffer.flush();

      // Only one write should be sent (the final one)
      expect(mockClient.write).toHaveBeenCalledTimes(1);
    });
  });
});
