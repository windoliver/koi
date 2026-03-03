/**
 * Tests for createScratchpadAdapter — validation, buffer delegation, and change events.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentGroupId,
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteResult,
} from "@koi/core";
import { agentGroupId, agentId, SCRATCHPAD_DEFAULTS, scratchpadPath } from "@koi/core";
import type { GenerationCache } from "./generation-cache.js";
import { createScratchpadAdapter } from "./scratchpad-adapter.js";
import type { ScratchpadClient } from "./scratchpad-client.js";
import type { BufferedWrite, WriteBuffer } from "./write-buffer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_GROUP_ID = agentGroupId("test-group");
const TEST_AUTHOR_ID = agentId("test-author");

function makeEntry(path: string, content: string): ScratchpadEntry {
  return {
    path: scratchpadPath(path),
    content,
    generation: 1 as ScratchpadGeneration,
    groupId: TEST_GROUP_ID,
    authorId: TEST_AUTHOR_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: new TextEncoder().encode(content).byteLength,
  };
}

function createMockWriteBuffer(): WriteBuffer {
  const buffer = new Map<ScratchpadPath, BufferedWrite>();

  return {
    add: mock((write: BufferedWrite): Promise<Result<ScratchpadWriteResult, KoiError>> => {
      buffer.set(write.path, write);
      return Promise.resolve({
        ok: true,
        value: {
          path: write.path,
          generation: ((write.expectedGeneration ?? 0) + 1) as ScratchpadGeneration,
          sizeBytes: new TextEncoder().encode(write.content).byteLength,
        },
      });
    }),
    flush: mock((): Promise<void> => {
      buffer.clear();
      return Promise.resolve();
    }),
    has: (path: ScratchpadPath): boolean => buffer.has(path),
    get: (path: ScratchpadPath): BufferedWrite | undefined => buffer.get(path),
    size: (): number => buffer.size,
  };
}

function createMockGenerationCache(): GenerationCache {
  return {
    read: mock(
      (_groupId: AgentGroupId, path: ScratchpadPath): Promise<Result<ScratchpadEntry, KoiError>> =>
        Promise.resolve({ ok: true, value: makeEntry(path, `cached-${path}`) }),
    ),
    invalidate: mock((_path: ScratchpadPath): void => undefined),
    clear: mock((): void => undefined),
    size: mock((): number => 0),
  };
}

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
        Promise.resolve({ ok: true, value: makeEntry("test", "data") }),
    ),
    generation: mock(
      (): Promise<Result<ScratchpadGeneration, KoiError>> =>
        Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
    ),
    list: mock(
      (
        _groupId: AgentGroupId,
        _filter?: ScratchpadFilter,
      ): Promise<Result<readonly ScratchpadEntrySummary[], KoiError>> =>
        Promise.resolve({
          ok: true,
          value: [
            {
              path: scratchpadPath("a.txt"),
              generation: 1 as ScratchpadGeneration,
              groupId: TEST_GROUP_ID,
              authorId: TEST_AUTHOR_ID,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              sizeBytes: 5,
            },
          ],
        }),
    ),
    delete: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
    provision: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createScratchpadAdapter", () => {
  let mockClient: ScratchpadClient;
  let mockWriteBuffer: WriteBuffer;
  let mockCache: GenerationCache;

  beforeEach(() => {
    mockClient = createMockClient();
    mockWriteBuffer = createMockWriteBuffer();
    mockCache = createMockGenerationCache();
  });

  function createAdapter() {
    return createScratchpadAdapter({
      client: mockClient,
      writeBuffer: mockWriteBuffer,
      generationCache: mockCache,
      groupId: TEST_GROUP_ID,
      authorId: TEST_AUTHOR_ID,
    });
  }

  // -------------------------------------------------------------------------
  // Write validation
  // -------------------------------------------------------------------------

  describe("write validation", () => {
    test("returns error when path is empty", async () => {
      const adapter = createAdapter();

      const result = await adapter.write({
        path: scratchpadPath(""),
        content: "hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("empty");
      }
    });

    test("returns error when path exceeds maximum length", async () => {
      const adapter = createAdapter();
      const longPath = "a".repeat(SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH + 1);

      const result = await adapter.write({
        path: scratchpadPath(longPath),
        content: "hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("maximum length");
      }
    });

    test("returns error when path contains '..'", async () => {
      const adapter = createAdapter();

      const result = await adapter.write({
        path: scratchpadPath("notes/../secret.txt"),
        content: "hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("..");
      }
    });

    test("returns error when path starts with '/'", async () => {
      const adapter = createAdapter();

      const result = await adapter.write({
        path: scratchpadPath("/absolute/path.txt"),
        content: "hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("start with '/'");
      }
    });

    test("returns error when content exceeds maximum size", async () => {
      const adapter = createAdapter();
      const largeContent = "x".repeat(SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES + 1);

      const result = await adapter.write({
        path: scratchpadPath("large.txt"),
        content: largeContent,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("maximum size");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Write buffering
  // -------------------------------------------------------------------------

  describe("write buffering", () => {
    test("delegates write to writeBuffer.add", async () => {
      const adapter = createAdapter();

      await adapter.write({
        path: scratchpadPath("notes/plan.md"),
        content: "hello",
      });

      expect(mockWriteBuffer.add).toHaveBeenCalledTimes(1);
    });

    test("invalidates generation cache on successful write", async () => {
      const adapter = createAdapter();

      await adapter.write({
        path: scratchpadPath("notes/plan.md"),
        content: "hello",
      });

      expect(mockCache.invalidate).toHaveBeenCalledWith(scratchpadPath("notes/plan.md"));
    });

    test("does not call client.write directly (buffered)", async () => {
      const adapter = createAdapter();

      await adapter.write({
        path: scratchpadPath("notes/plan.md"),
        content: "hello",
      });

      expect(mockClient.write).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  describe("read", () => {
    test("flushes buffer before reading", async () => {
      const adapter = createAdapter();

      await adapter.read(scratchpadPath("notes/plan.md"));

      expect(mockWriteBuffer.flush).toHaveBeenCalledTimes(1);
    });

    test("delegates to generationCache.read after flush", async () => {
      const adapter = createAdapter();

      const result = await adapter.read(scratchpadPath("data.json"));

      expect(result.ok).toBe(true);
      expect(mockCache.read).toHaveBeenCalledWith(TEST_GROUP_ID, scratchpadPath("data.json"));
    });
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  describe("list", () => {
    test("flushes buffer before listing", async () => {
      const adapter = createAdapter();

      await adapter.list();

      expect(mockWriteBuffer.flush).toHaveBeenCalledTimes(1);
    });

    test("delegates to client.list", async () => {
      const adapter = createAdapter();

      const entries = await adapter.list({ glob: "*.txt" });

      expect(mockClient.list).toHaveBeenCalledWith(TEST_GROUP_ID, { glob: "*.txt" });
      expect(entries).toHaveLength(1);
    });

    test("returns empty array when client returns error", async () => {
      mockClient = {
        ...mockClient,
        list: mock(
          (): Promise<Result<readonly ScratchpadEntrySummary[], KoiError>> =>
            Promise.resolve({
              ok: false,
              error: { code: "INTERNAL", message: "List failed", retryable: true },
            }),
        ),
      };
      const adapter = createScratchpadAdapter({
        client: mockClient,
        writeBuffer: mockWriteBuffer,
        generationCache: mockCache,
        groupId: TEST_GROUP_ID,
        authorId: TEST_AUTHOR_ID,
      });

      const entries = await adapter.list();

      expect(entries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    test("flushes buffer before deleting", async () => {
      const adapter = createAdapter();

      await adapter.delete(scratchpadPath("notes/plan.md"));

      expect(mockWriteBuffer.flush).toHaveBeenCalledTimes(1);
    });

    test("invalidates cache on successful delete", async () => {
      const adapter = createAdapter();

      await adapter.delete(scratchpadPath("notes/plan.md"));

      expect(mockCache.invalidate).toHaveBeenCalledWith(scratchpadPath("notes/plan.md"));
    });

    test("delegates to client.delete", async () => {
      const adapter = createAdapter();

      const result = await adapter.delete(scratchpadPath("notes/plan.md"));

      expect(result.ok).toBe(true);
      expect(mockClient.delete).toHaveBeenCalledWith(
        TEST_GROUP_ID,
        scratchpadPath("notes/plan.md"),
      );
    });

    test("does not invalidate cache on failed delete", async () => {
      mockClient = {
        ...mockClient,
        delete: mock(
          (): Promise<Result<void, KoiError>> =>
            Promise.resolve({
              ok: false,
              error: { code: "NOT_FOUND", message: "Not found", retryable: false },
            }),
        ),
      };
      const adapter = createScratchpadAdapter({
        client: mockClient,
        writeBuffer: mockWriteBuffer,
        generationCache: mockCache,
        groupId: TEST_GROUP_ID,
        authorId: TEST_AUTHOR_ID,
      });

      await adapter.delete(scratchpadPath("missing.txt"));

      expect(mockCache.invalidate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  describe("flush", () => {
    test("delegates to writeBuffer.flush", async () => {
      const adapter = createAdapter();

      await adapter.flush();

      expect(mockWriteBuffer.flush).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // onChange
  // -------------------------------------------------------------------------

  describe("onChange", () => {
    test("registers listener and notifies on write", async () => {
      const adapter = createAdapter();
      const events: ScratchpadChangeEvent[] = [];

      adapter.onChange((event) => {
        events.push(event);
      });

      await adapter.write({
        path: scratchpadPath("notes/plan.md"),
        content: "hello",
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("written");
      expect(events[0]?.path).toBe(scratchpadPath("notes/plan.md"));
      expect(events[0]?.authorId).toBe(TEST_AUTHOR_ID);
      expect(events[0]?.groupId).toBe(TEST_GROUP_ID);
    });

    test("notifies on delete", async () => {
      const adapter = createAdapter();
      const events: ScratchpadChangeEvent[] = [];

      adapter.onChange((event) => {
        events.push(event);
      });

      await adapter.delete(scratchpadPath("notes/plan.md"));

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("deleted");
      expect(events[0]?.path).toBe(scratchpadPath("notes/plan.md"));
    });

    test("unsubscribe stops notifications", async () => {
      const adapter = createAdapter();
      const events: ScratchpadChangeEvent[] = [];

      const unsubscribe = adapter.onChange((event) => {
        events.push(event);
      });

      await adapter.write({
        path: scratchpadPath("a.txt"),
        content: "first",
      });
      expect(events).toHaveLength(1);

      unsubscribe();

      await adapter.write({
        path: scratchpadPath("b.txt"),
        content: "second",
      });
      // Should still be 1 — no new event after unsubscribe
      expect(events).toHaveLength(1);
    });

    test("multiple listeners all receive events", async () => {
      const adapter = createAdapter();
      const events1: ScratchpadChangeEvent[] = [];
      const events2: ScratchpadChangeEvent[] = [];

      adapter.onChange((event) => events1.push(event));
      adapter.onChange((event) => events2.push(event));

      await adapter.write({
        path: scratchpadPath("shared.txt"),
        content: "data",
      });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    test("does not notify on failed write (validation error)", async () => {
      const adapter = createAdapter();
      const events: ScratchpadChangeEvent[] = [];

      adapter.onChange((event) => events.push(event));

      // Empty path triggers validation error
      await adapter.write({
        path: scratchpadPath(""),
        content: "hello",
      });

      expect(events).toHaveLength(0);
    });
  });
});
