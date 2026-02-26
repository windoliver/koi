import { describe, expect, test } from "bun:test";
import { encodeSseKeepalive, encodeSseMessage, encodeSseMessageWithId } from "./encoder.js";

const decoder = new TextDecoder();

describe("encodeSseMessage", () => {
  test("encodes JSON data as SSE frame", () => {
    const result = decoder.decode(encodeSseMessage({ hello: "world" }));
    expect(result).toBe('data: {"hello":"world"}\n\n');
  });

  test("encodes string data", () => {
    const result = decoder.decode(encodeSseMessage("test"));
    expect(result).toBe('data: "test"\n\n');
  });

  test("encodes number data", () => {
    const result = decoder.decode(encodeSseMessage(42));
    expect(result).toBe("data: 42\n\n");
  });
});

describe("encodeSseKeepalive", () => {
  test("encodes keepalive comment", () => {
    const result = decoder.decode(encodeSseKeepalive());
    expect(result).toBe(":keepalive\n\n");
  });
});

describe("encodeSseMessageWithId", () => {
  test("encodes SSE frame with id field", () => {
    const result = decoder.decode(encodeSseMessageWithId({ seq: 1 }, "1"));
    expect(result).toBe('id: 1\ndata: {"seq":1}\n\n');
  });
});
