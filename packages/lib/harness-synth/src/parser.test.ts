import { describe, expect, test } from "bun:test";
import { parseSynthesisOutput } from "./parser.js";

const VALID_RAW = [
  '<descriptor>{ "name": "echo_tool", "description": "Echoes input", "inputSchema": { "type": "object" } }</descriptor>',
  "<code>export const run = (x) => x;</code>",
].join("\n");

describe("parseSynthesisOutput", () => {
  test("parses valid descriptor + code", () => {
    const result = parseSynthesisOutput(VALID_RAW, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor.name).toBe("echo_tool");
    expect(result.value.descriptor.description).toBe("Echoes input");
    expect(result.value.code).toBe("export const run = (x) => x;");
  });

  test("rejects missing descriptor section", () => {
    const result = parseSynthesisOutput("<code>x</code>", "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/<descriptor>/);
  });

  test("rejects missing code section", () => {
    const result = parseSynthesisOutput(
      '<descriptor>{ "name": "echo_tool", "description": "x", "inputSchema": {} }</descriptor>',
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/<code>/);
  });

  test("rejects empty code", () => {
    const raw = [
      '<descriptor>{ "name": "echo_tool", "description": "x", "inputSchema": {} }</descriptor>',
      "<code>   </code>",
    ].join("\n");
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty/);
  });

  test("rejects malformed descriptor JSON", () => {
    const raw = ["<descriptor>{ not json }</descriptor>", "<code>x</code>"].join("\n");
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/JSON parse failed/);
  });

  test("rejects mismatched tool name", () => {
    const raw = [
      '<descriptor>{ "name": "wrong", "description": "x", "inputSchema": {} }</descriptor>',
      "<code>x</code>",
    ].join("\n");
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/does not match/);
  });

  test("rejects descriptor missing required fields", () => {
    const raw = ['<descriptor>{ "name": "echo_tool" }</descriptor>', "<code>x</code>"].join("\n");
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/description/);
  });

  test("rejects non-object inputSchema", () => {
    const raw = [
      '<descriptor>{ "name": "echo_tool", "description": "x", "inputSchema": [] }</descriptor>',
      "<code>x</code>",
    ].join("\n");
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inputSchema/);
  });
});
