import { describe, expect, test } from "bun:test";
import { loadCassette } from "./load-cassette.js";

const FIXTURES_DIR = `${import.meta.dirname}/../../fixtures`;

describe("loadCassette", () => {
  // -------------------------------------------------------------------------
  // Top-level field validation
  // -------------------------------------------------------------------------

  test("rejects missing file", async () => {
    await expect(loadCassette(`${FIXTURES_DIR}/nonexistent.json`)).rejects.toThrow(
      "Cassette not found",
    );
  });

  test("rejects cassette missing name field", async () => {
    const path = writeTempFixture({ model: "test", recordedAt: 1, chunks: [] });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "name"');
  });

  test("rejects cassette missing model field", async () => {
    const path = writeTempFixture({ name: "test", recordedAt: 1, chunks: [] });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "model"');
  });

  test("rejects cassette missing recordedAt field", async () => {
    const path = writeTempFixture({ name: "test", model: "m", chunks: [] });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "recordedAt"');
  });

  test("rejects cassette with non-array chunks", async () => {
    const path = writeTempFixture({
      name: "test",
      model: "m",
      recordedAt: 1,
      chunks: "not-an-array",
    });
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "chunks"');
  });

  // -------------------------------------------------------------------------
  // Per-chunk payload validation
  // -------------------------------------------------------------------------

  test("rejects chunk without kind field", async () => {
    const path = writeTempFixture(withChunks([{ delta: "orphan" }]));
    await expect(loadCassette(path)).rejects.toThrow('chunks[0] missing "kind"');
  });

  test("rejects text_delta chunk missing delta", async () => {
    const path = writeTempFixture(withChunks([{ kind: "text_delta" }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "delta"');
  });

  test("rejects tool_call_start chunk missing toolName", async () => {
    const path = writeTempFixture(withChunks([{ kind: "tool_call_start", callId: "tc1" }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "toolName"');
  });

  test("rejects tool_call_start chunk missing callId", async () => {
    const path = writeTempFixture(withChunks([{ kind: "tool_call_start", toolName: "read" }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "callId"');
  });

  test("rejects usage chunk missing inputTokens", async () => {
    const path = writeTempFixture(withChunks([{ kind: "usage", outputTokens: 5 }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "inputTokens"');
  });

  test("rejects error chunk missing message", async () => {
    const path = writeTempFixture(withChunks([{ kind: "error" }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "message"');
  });

  test("rejects done chunk missing response", async () => {
    const path = writeTempFixture(withChunks([{ kind: "done" }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "response"');
  });

  test("rejects done chunk with response missing content", async () => {
    const path = writeTempFixture(withChunks([{ kind: "done", response: { model: "m" } }]));
    await expect(loadCassette(path)).rejects.toThrow('missing or invalid "content"');
  });

  test("rejects done chunk with response missing model", async () => {
    const path = writeTempFixture(withChunks([{ kind: "done", response: { content: "ok" } }]));
    await expect(loadCassette(path)).rejects.toThrow('response missing or invalid "model"');
  });

  test("rejects done chunk with malformed response.usage", async () => {
    const path = writeTempFixture(
      withChunks([
        {
          kind: "done",
          response: {
            content: "ok",
            model: "m",
            usage: { inputTokens: "bad", outputTokens: 1 },
          },
        },
      ]),
    );
    await expect(loadCassette(path)).rejects.toThrow(
      'response usage missing or invalid "inputTokens"',
    );
  });

  test("rejects error chunk with malformed usage", async () => {
    const path = writeTempFixture(
      withChunks([
        { kind: "error", message: "fail", usage: { inputTokens: 5, outputTokens: "bad" } },
      ]),
    );
    await expect(loadCassette(path)).rejects.toThrow('usage missing or invalid "outputTokens"');
  });

  test("accepts error chunk without usage (optional)", async () => {
    const path = writeTempFixture(withChunks([{ kind: "error", message: "fail" }]));
    // Should not throw — usage is optional on error chunks
    const cassette = await loadCassette(path);
    expect(cassette.chunks).toHaveLength(1);
  });

  test("rejects chunk with unknown kind", async () => {
    const path = writeTempFixture(withChunks([{ kind: "invented_event" }]));
    await expect(loadCassette(path)).rejects.toThrow('unknown kind "invented_event"');
  });

  test("reports correct index for malformed chunk deep in array", async () => {
    const path = writeTempFixture(
      withChunks([
        { kind: "text_delta", delta: "ok" },
        { kind: "text_delta", delta: "ok" },
        { kind: "usage", inputTokens: 10 }, // missing outputTokens
      ]),
    );
    await expect(loadCassette(path)).rejects.toThrow("chunks[2]");
  });

  // -------------------------------------------------------------------------
  // Valid cassettes
  // -------------------------------------------------------------------------

  test("accepts valid cassette with empty chunks", async () => {
    const path = writeTempFixture({
      name: "empty",
      model: "test-model",
      recordedAt: Date.now(),
      chunks: [],
    });
    const cassette = await loadCassette(path);
    expect(cassette.name).toBe("empty");
    expect(cassette.model).toBe("test-model");
    expect(cassette.chunks).toEqual([]);
  });

  test("accepts valid cassette with all chunk kinds", async () => {
    const path = writeTempFixture(
      withChunks([
        { kind: "text_delta", delta: "hello" },
        { kind: "thinking_delta", delta: "hmm" },
        { kind: "tool_call_start", toolName: "read", callId: "tc1" },
        { kind: "tool_call_delta", callId: "tc1", delta: '{"a":1}' },
        { kind: "tool_call_end", callId: "tc1" },
        { kind: "usage", inputTokens: 10, outputTokens: 5 },
        { kind: "done", response: { content: "hello", model: "test-model" } },
      ]),
    );
    const cassette = await loadCassette(path);
    expect(cassette.chunks).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempCounter = 0;

function writeTempFixture(data: unknown): string {
  const path = `/tmp/koi-cassette-test-${Date.now()}-${tempCounter++}.json`;
  Bun.write(path, JSON.stringify(data));
  return path;
}

/** Wraps chunks in a valid cassette envelope for testing chunk validation. */
function withChunks(chunks: readonly unknown[]): unknown {
  return { name: "test", model: "test-model", recordedAt: 1000, chunks };
}
