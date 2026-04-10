import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, ToolRequest } from "@koi/core";
import {
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "./create-mock-handlers.js";

const modelReq: ModelRequest = { messages: [] };
const toolReq: ToolRequest = { toolId: "x", input: {} };

describe("createSpyModelHandler", () => {
  test("records calls and returns merged response", async () => {
    const { handler, calls } = createSpyModelHandler({ content: "hi" });
    const res = await handler(modelReq);
    expect(res.content).toBe("hi");
    expect(res.model).toBe("mock-model");
    expect(calls).toHaveLength(1);
  });
});

describe("createSpyModelStreamHandler", () => {
  test("records calls and yields scripted chunks", async () => {
    const chunks: ModelChunk[] = [{ kind: "text_delta", delta: "yo" }];
    const { handler, calls } = createSpyModelStreamHandler(chunks);
    const received: ModelChunk[] = [];
    for await (const c of handler(modelReq)) {
      received.push(c);
    }
    expect(received).toEqual(chunks);
    expect(calls).toHaveLength(1);
  });
});

describe("createSpyToolHandler", () => {
  test("records calls and returns merged response", async () => {
    const { handler, calls } = createSpyToolHandler({ output: { ok: true } });
    const res = await handler(toolReq);
    expect(res.output).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test("default output is null", async () => {
    const { handler } = createSpyToolHandler();
    const res = await handler(toolReq);
    expect(res.output).toBeNull();
  });
});
