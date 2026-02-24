import { describe, expect, test } from "bun:test";
import {
  fetchWithTimeout,
  handleAbortError,
  handleStreamAbortError,
  mapStatusToErrorCode,
  parseRetryAfter,
  parseSSEStream,
  streamFetch,
} from "./shared.js";

// ---------------------------------------------------------------------------
// mapStatusToErrorCode
// ---------------------------------------------------------------------------

describe("mapStatusToErrorCode", () => {
  test("401 → PERMISSION", () => {
    expect(mapStatusToErrorCode(401)).toBe("PERMISSION");
  });

  test("403 → PERMISSION", () => {
    expect(mapStatusToErrorCode(403)).toBe("PERMISSION");
  });

  test("404 → NOT_FOUND", () => {
    expect(mapStatusToErrorCode(404)).toBe("NOT_FOUND");
  });

  test("429 → RATE_LIMIT", () => {
    expect(mapStatusToErrorCode(429)).toBe("RATE_LIMIT");
  });

  test("408 → TIMEOUT", () => {
    expect(mapStatusToErrorCode(408)).toBe("TIMEOUT");
  });

  test("504 → TIMEOUT", () => {
    expect(mapStatusToErrorCode(504)).toBe("TIMEOUT");
  });

  test("500 → EXTERNAL", () => {
    expect(mapStatusToErrorCode(500)).toBe("EXTERNAL");
  });

  test("502 → EXTERNAL", () => {
    expect(mapStatusToErrorCode(502)).toBe("EXTERNAL");
  });

  test("400 → EXTERNAL (default)", () => {
    expect(mapStatusToErrorCode(400)).toBe("EXTERNAL");
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

describe("parseRetryAfter", () => {
  test("returns milliseconds from seconds value", () => {
    const headers = new Headers({ "retry-after": "5.5" });
    expect(parseRetryAfter(headers)).toBe(5500);
  });

  test("returns undefined when header missing", () => {
    const headers = new Headers();
    expect(parseRetryAfter(headers)).toBeUndefined();
  });

  test("returns undefined for non-numeric value", () => {
    const headers = new Headers({ "retry-after": "not-a-number" });
    expect(parseRetryAfter(headers)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    const headers = new Headers({ "retry-after": "" });
    expect(parseRetryAfter(headers)).toBeUndefined();
  });

  test("ceils fractional milliseconds", () => {
    const headers = new Headers({ "retry-after": "1.1" });
    expect(parseRetryAfter(headers)).toBe(1100);
  });

  test("handles integer seconds", () => {
    const headers = new Headers({ "retry-after": "3" });
    expect(parseRetryAfter(headers)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// handleAbortError
// ---------------------------------------------------------------------------

describe("handleAbortError", () => {
  test("returns TIMEOUT error for internal timeout abort", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");
    const result = handleAbortError(error, "TestProvider", 5000);

    expect(result.code).toBe("TIMEOUT");
    expect(result.message).toContain("timed out after 5000ms");
    expect(result.retryable).toBe(true);
  });

  test("returns EXTERNAL error for caller-initiated abort", () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("The operation was aborted.", "AbortError");
    const result = handleAbortError(error, "TestProvider", 5000, controller.signal);

    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toContain("cancelled");
    expect(result.retryable).toBe(false);
  });

  test("re-throws non-abort errors", () => {
    const error = new Error("network failure");
    expect(() => handleAbortError(error, "TestProvider", 5000)).toThrow("network failure");
  });

  test("includes provider name in error message", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");
    const result = handleAbortError(error, "Ollama", 10000);
    expect(result.message).toContain("Ollama");
  });
});

// ---------------------------------------------------------------------------
// handleStreamAbortError
// ---------------------------------------------------------------------------

describe("handleStreamAbortError", () => {
  test("returns idle timeout message for internal abort", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");
    const msg = handleStreamAbortError(error, "TestProvider", 5000);
    expect(msg).toContain("idle timeout after 5000ms");
  });

  test("returns cancelled message for caller abort", () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("The operation was aborted.", "AbortError");
    const msg = handleStreamAbortError(error, "TestProvider", 5000, controller.signal);
    expect(msg).toContain("cancelled");
  });

  test("returns error message for non-abort Error", () => {
    const error = new Error("socket hang up");
    const msg = handleStreamAbortError(error, "TestProvider", 5000);
    expect(msg).toBe("socket hang up");
  });

  test("converts non-Error to string", () => {
    const msg = handleStreamAbortError(42, "TestProvider", 5000);
    expect(msg).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// parseSSEStream
// ---------------------------------------------------------------------------

describe("parseSSEStream", () => {
  function makeStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  test("parses data lines from SSE stream", async () => {
    const stream = makeStream(["data: hello\n\n", "data: world\n\n"]);
    const results: string[] = [];
    for await (const item of parseSSEStream(stream, (data) => data)) {
      results.push(item);
    }
    expect(results).toEqual(["hello", "world"]);
  });

  test("ignores non-data lines", async () => {
    const stream = makeStream(["event: test\n", "data: hello\n\n", ": comment\n", "data: end\n\n"]);
    const results: string[] = [];
    for await (const item of parseSSEStream(stream, (data) => data)) {
      results.push(item);
    }
    expect(results).toEqual(["hello", "end"]);
  });

  test("ignores empty lines", async () => {
    const stream = makeStream(["\n\ndata: hello\n\n\n"]);
    const results: string[] = [];
    for await (const item of parseSSEStream(stream, (data) => data)) {
      results.push(item);
    }
    expect(results).toEqual(["hello"]);
  });

  test("handles partial lines across chunks", async () => {
    const stream = makeStream(["dat", "a: split-across\n\n"]);
    const results: string[] = [];
    for await (const item of parseSSEStream(stream, (data) => data)) {
      results.push(item);
    }
    expect(results).toEqual(["split-across"]);
  });

  test("parseLine returning undefined skips the line", async () => {
    const stream = makeStream(["data: skip\n", "data: keep\n\n"]);
    const results: string[] = [];
    for await (const item of parseSSEStream(stream, (data) =>
      data === "skip" ? undefined : data,
    )) {
      results.push(item);
    }
    expect(results).toEqual(["keep"]);
  });

  test("calls onChunk for each raw chunk", async () => {
    const stream = makeStream(["data: a\n\n", "data: b\n\n"]);
    let chunkCount = 0;
    const results: string[] = [];
    for await (const item of parseSSEStream(
      stream,
      (data) => data,
      () => {
        chunkCount++;
      },
    )) {
      results.push(item);
    }
    expect(chunkCount).toBe(2);
    expect(results).toEqual(["a", "b"]);
  });

  test("handles JSON data lines", async () => {
    const stream = makeStream(['data: {"key":"value"}\n\n']);
    const results: Record<string, string>[] = [];
    for await (const item of parseSSEStream<Record<string, string>>(stream, (data) => {
      try {
        return JSON.parse(data) as Record<string, string>;
      } catch {
        return undefined;
      }
    })) {
      results.push(item);
    }
    expect(results).toEqual([{ key: "value" }]);
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe("fetchWithTimeout", () => {
  const originalFetch = globalThis.fetch;

  test("passes request parameters to fetch", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await fetchWithTimeout({
        url: "https://example.com/api",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"key":"value"}',
        timeoutMs: 5000,
      });
      result.clearTimer();

      expect(capturedUrl).toBe("https://example.com/api");
      expect(capturedInit?.method).toBe("POST");
      expect(capturedInit?.body).toBe('{"key":"value"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clearTimer prevents timer leak", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    try {
      const result = await fetchWithTimeout({
        url: "https://example.com",
        method: "GET",
        headers: {},
        timeoutMs: 5000,
      });
      // Should not throw
      result.clearTimer();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// streamFetch
// ---------------------------------------------------------------------------

describe("streamFetch", () => {
  const originalFetch = globalThis.fetch;

  test("returns response and timer controls", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    try {
      const result = await streamFetch({
        url: "https://example.com/stream",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 5000,
      });

      expect(result.response.status).toBe(200);
      expect(typeof result.resetTimer).toBe("function");
      expect(typeof result.clearTimer).toBe("function");
      result.clearTimer();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
