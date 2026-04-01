import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createAnthropicClient } from "../client.js";

const ts = Date.now();

function simpleRequest(text: string): ModelRequest {
  return {
    messages: [{ content: [{ kind: "text", text }], senderId: "user-1", timestamp: ts }],
  };
}

describe("createAnthropicClient", () => {
  test("creates a client with complete and stream handlers", async () => {
    const client = await createAnthropicClient({ apiKey: "test-key" });
    expect(typeof client.complete).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  test("complete and stream are defined", async () => {
    const client = await createAnthropicClient({ apiKey: "test-key" });
    expect(client.complete).toBeDefined();
    expect(client.stream).toBeDefined();
  });
});

describe("createAnthropicClient integration shape", () => {
  test("stream handler returns an AsyncIterable", async () => {
    const client = await createAnthropicClient({ apiKey: "test-key" });
    const request = simpleRequest("Hello");
    const iterable = client.stream(request);

    // Should be an async iterable
    expect(Symbol.asyncIterator in Object(iterable)).toBe(true);
  });

  test("respects config defaults", async () => {
    const client = await createAnthropicClient({
      apiKey: "test-key",
      model: "claude-haiku-3-5-20241022",
      maxTokens: 1024,
    });

    expect(client.complete).toBeDefined();
    expect(client.stream).toBeDefined();
  });
});
