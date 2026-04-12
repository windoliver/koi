import { afterEach, describe, expect, test } from "bun:test";
import { clearCassetteCache, loadCassette } from "./load-cassette.js";

// Real committed fixtures — path relative to this file
const FIXTURES = `${import.meta.dirname}/../../../meta/runtime/fixtures`;

afterEach(() => {
  clearCassetteCache();
});

// ---------------------------------------------------------------------------
// schemaVersion validation (Issue 12A)
// ---------------------------------------------------------------------------

describe("schemaVersion validation", () => {
  test("rejects cassette with missing schemaVersion", async () => {
    const path = writeTempCassette({ name: "x", model: "m", recordedAt: 1, chunks: [] });
    await expect(loadCassette(path)).rejects.toThrow('missing "schemaVersion"');
  });

  test("rejects cassette with unknown schemaVersion", async () => {
    const path = writeTempCassette({
      schemaVersion: "cassette-v99",
      name: "x",
      model: "m",
      recordedAt: 1,
      chunks: [],
    });
    await expect(loadCassette(path)).rejects.toThrow('unknown schemaVersion "cassette-v99"');
  });

  test("accepts cassette-v1", async () => {
    const path = writeTempCassette(validEnvelope());
    const cassette = await loadCassette(path);
    expect(cassette.schemaVersion).toBe("cassette-v1");
  });
});

// ---------------------------------------------------------------------------
// Top-level field validation
// ---------------------------------------------------------------------------

describe("top-level field validation", () => {
  test("rejects missing file", async () => {
    await expect(loadCassette("/tmp/does-not-exist-koi-replay.json")).rejects.toThrow(
      "Cassette not found",
    );
  });

  test("rejects non-object", async () => {
    const path = writeTempRaw('"not an object"');
    await expect(loadCassette(path)).rejects.toThrow("expected object");
  });

  test("rejects missing name", async () => {
    const path = writeTempCassette({
      schemaVersion: "cassette-v1",
      model: "m",
      recordedAt: 1,
      chunks: [],
    });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "name"');
  });

  test("rejects missing model", async () => {
    const path = writeTempCassette({
      schemaVersion: "cassette-v1",
      name: "x",
      recordedAt: 1,
      chunks: [],
    });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "model"');
  });

  test("rejects missing recordedAt", async () => {
    const path = writeTempCassette({
      schemaVersion: "cassette-v1",
      name: "x",
      model: "m",
      chunks: [],
    });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "recordedAt"');
  });

  test("rejects non-array chunks", async () => {
    const path = writeTempCassette({
      schemaVersion: "cassette-v1",
      name: "x",
      model: "m",
      recordedAt: 1,
      chunks: "bad",
    });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "chunks"');
  });
});

// ---------------------------------------------------------------------------
// Chunk validation via isModelChunk (Issue 5B)
// ---------------------------------------------------------------------------

describe("chunk validation", () => {
  test("rejects chunk with unknown kind", async () => {
    const path = writeTempCassette(withChunks([{ kind: "invented_event" }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("rejects text_delta chunk missing delta", async () => {
    const path = writeTempCassette(withChunks([{ kind: "text_delta" }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("rejects tool_call_start chunk missing callId", async () => {
    const path = writeTempCassette(withChunks([{ kind: "tool_call_start", toolName: "read" }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("rejects usage chunk missing outputTokens", async () => {
    const path = writeTempCassette(withChunks([{ kind: "usage", inputTokens: 5 }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("rejects error chunk missing message", async () => {
    const path = writeTempCassette(withChunks([{ kind: "error" }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("rejects done chunk missing response.content", async () => {
    const path = writeTempCassette(withChunks([{ kind: "done", response: { model: "m" } }]));
    await expect(loadCassette(path)).rejects.toThrow("chunks[0] is not a valid ModelChunk");
  });

  test("reports correct index for bad chunk deep in array", async () => {
    const path = writeTempCassette(
      withChunks([
        { kind: "text_delta", delta: "ok" },
        { kind: "text_delta", delta: "ok" },
        { kind: "usage", inputTokens: 10 }, // missing outputTokens
      ]),
    );
    await expect(loadCassette(path)).rejects.toThrow("chunks[2]");
  });

  test("accepts error chunk without optional fields", async () => {
    const path = writeTempCassette(withChunks([{ kind: "error", message: "fail" }]));
    const cassette = await loadCassette(path);
    expect(cassette.chunks).toHaveLength(1);
  });

  test("accepts all valid chunk kinds", async () => {
    const path = writeTempCassette(
      withChunks([
        { kind: "text_delta", delta: "hello" },
        { kind: "thinking_delta", delta: "hmm" },
        { kind: "tool_call_start", toolName: "read", callId: "tc1" },
        { kind: "tool_call_delta", callId: "tc1", delta: '{"a":1}' },
        { kind: "tool_call_end", callId: "tc1" },
        { kind: "usage", inputTokens: 10, outputTokens: 5 },
        { kind: "done", response: { content: "hello", model: "m" } },
      ]),
    );
    const cassette = await loadCassette(path);
    expect(cassette.chunks).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Caching (Issue 13A)
// ---------------------------------------------------------------------------

describe("caching", () => {
  test("returns same object on second call (cache hit)", async () => {
    const path = writeTempCassette(validEnvelope());
    const first = await loadCassette(path);
    const second = await loadCassette(path);
    expect(first).toBe(second); // reference equality — same cached object
  });

  test("clearCassetteCache allows reload", async () => {
    const path = writeTempCassette(validEnvelope());
    const first = await loadCassette(path);
    clearCassetteCache();
    const second = await loadCassette(path);
    expect(first).not.toBe(second); // different object after cache clear
    expect(first.name).toBe(second.name); // same content
  });
});

// ---------------------------------------------------------------------------
// Real committed fixtures (Issue 11A)
// ---------------------------------------------------------------------------

describe("real fixture files", () => {
  test("loads simple-text.cassette.json with correct shape", async () => {
    const cassette = await loadCassette(`${FIXTURES}/simple-text.cassette.json`);
    expect(cassette.schemaVersion).toBe("cassette-v1");
    expect(cassette.name).toBe("simple-text");
    expect(typeof cassette.model).toBe("string");
    expect(cassette.chunks.length).toBeGreaterThan(0);
    // Volatile fields must be stripped by migration
    const doneChunk = cassette.chunks.find((c) => c.kind === "done");
    expect(doneChunk).toBeDefined();
    if (doneChunk?.kind === "done") {
      expect((doneChunk.response as unknown as Record<string, unknown>).responseId).toBeUndefined();
      expect((doneChunk.response as unknown as Record<string, unknown>).metadata).toBeUndefined();
    }
  });

  test("loads tool-use.cassette.json with at least one tool_call_start chunk", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    expect(cassette.schemaVersion).toBe("cassette-v1");
    const toolStart = cassette.chunks.find((c) => c.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
  });

  test("loads memory-store.cassette.json successfully", async () => {
    const cassette = await loadCassette(`${FIXTURES}/memory-store.cassette.json`);
    expect(cassette.schemaVersion).toBe("cassette-v1");
    expect(cassette.chunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function writeTempCassette(data: unknown): string {
  const path = `/tmp/koi-replay-test-${Date.now()}-${counter++}.json`;
  Bun.write(path, JSON.stringify(data));
  return path;
}
function writeTempRaw(content: string): string {
  const path = `/tmp/koi-replay-test-raw-${Date.now()}-${counter++}.json`;
  Bun.write(path, content);
  return path;
}
function validEnvelope(): unknown {
  return { schemaVersion: "cassette-v1", name: "test", model: "m", recordedAt: 1, chunks: [] };
}
function withChunks(chunks: readonly unknown[]): unknown {
  return { schemaVersion: "cassette-v1", name: "test", model: "m", recordedAt: 1, chunks };
}
