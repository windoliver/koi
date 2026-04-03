import { describe, expect, test } from "bun:test";
import { parseEngineInput } from "./parse-engine-input.js";

describe("parseEngineInput", () => {
  test("wraps plain text as text EngineInput", () => {
    const result = parseEngineInput("do something");
    expect(result).toEqual({ kind: "text", text: "do something" });
  });

  test("wraps non-EngineInput JSON as text", () => {
    const result = parseEngineInput('{"foo":"bar"}');
    expect(result).toEqual({ kind: "text", text: '{"foo":"bar"}' });
  });

  test("passes through JSON with kind=text as structured EngineInput", () => {
    const raw = JSON.stringify({ kind: "text", text: "hello" });
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  test("passes through JSON with kind=messages as structured EngineInput", () => {
    const raw = JSON.stringify({ kind: "messages", messages: [] });
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "messages", messages: [] });
  });

  test("passes through JSON with kind=resume as structured EngineInput", () => {
    const raw = JSON.stringify({ kind: "resume", state: { engineId: "e-1", data: null } });
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "resume", state: { engineId: "e-1", data: null } });
  });

  test("wraps JSON with unknown kind as text", () => {
    const raw = JSON.stringify({ kind: "unknown", data: 123 });
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "text", text: raw });
  });

  test("wraps JSON array as text", () => {
    const raw = JSON.stringify([1, 2, 3]);
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "text", text: raw });
  });

  test("wraps JSON with non-string kind as text", () => {
    const raw = JSON.stringify({ kind: 42 });
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "text", text: raw });
  });

  test("wraps invalid JSON as text", () => {
    const raw = "not { valid json";
    const result = parseEngineInput(raw);
    expect(result).toEqual({ kind: "text", text: raw });
  });
});
