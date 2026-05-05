import { describe, expect, test } from "bun:test";
import { parseSynthesisOutput } from "./parser.js";

function rawWith(descriptor: unknown, code: unknown): string {
  return JSON.stringify({ descriptor, code });
}

const VALID_DESCRIPTOR = {
  name: "echo_tool",
  description: "Echoes input",
  inputSchema: { type: "object" },
};

describe("parseSynthesisOutput", () => {
  test("parses valid JSON output", () => {
    const result = parseSynthesisOutput(
      rawWith(VALID_DESCRIPTOR, "export const run = (x) => x;"),
      "echo_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor.name).toBe("echo_tool");
    expect(result.value.descriptor.description).toBe("Echoes input");
    expect(result.value.code).toBe("export const run = (x) => x;");
  });

  test("preserves source containing previous-format sentinels in JSON string", () => {
    // Regression: old <code>...</code> regex parser truncated at literal
    // "</code>" inside source. JSON-string transport handles it natively.
    const code = 'const html = "<code>hi</code>"; const tag = "</code>";';
    const result = parseSynthesisOutput(rawWith(VALID_DESCRIPTOR, code), "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe(code);
  });

  test("tolerates leading prose / markdown fences around the JSON", () => {
    const json = rawWith(VALID_DESCRIPTOR, "export const run = (x) => x;");
    const wrapped = `Sure — here it is:\n\n\`\`\`json\n${json}\n\`\`\`\n`;
    const result = parseSynthesisOutput(wrapped, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("export const run = (x) => x;");
  });

  test("rejects missing JSON object", () => {
    const result = parseSynthesisOutput("no json at all", "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/No JSON object/);
  });

  test("rejects malformed JSON", () => {
    const result = parseSynthesisOutput("{ not json }", "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/JSON parse failed/);
  });

  test("rejects non-string code", () => {
    const result = parseSynthesisOutput(
      JSON.stringify({ descriptor: VALID_DESCRIPTOR, code: 42 }),
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/code must be a string/);
  });

  test("rejects empty code", () => {
    const result = parseSynthesisOutput(rawWith(VALID_DESCRIPTOR, "   "), "echo_tool");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty/);
  });

  test("rejects mismatched tool name", () => {
    const result = parseSynthesisOutput(
      rawWith({ ...VALID_DESCRIPTOR, name: "wrong" }, "x"),
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/does not match/);
  });

  test("rejects descriptor missing description", () => {
    const result = parseSynthesisOutput(
      rawWith({ name: "echo_tool", inputSchema: {} }, "x"),
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/description/);
  });

  test("rejects array inputSchema", () => {
    const result = parseSynthesisOutput(
      rawWith({ ...VALID_DESCRIPTOR, inputSchema: [] }, "x"),
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inputSchema/);
  });

  test("skips earlier prose-brace fragments and finds the real payload", () => {
    // Regression: parser used to grab the first balanced `{...}` even when it
    // was prose like "{descriptor, code}: ..." and then fail to JSON.parse it.
    const real = rawWith(VALID_DESCRIPTOR, "x();");
    const wrapped = `Use the {descriptor, code} object format. Here it is:\n${real}`;
    const result = parseSynthesisOutput(wrapped, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("x();");
  });

  test("rejects non-object descriptor", () => {
    const result = parseSynthesisOutput(
      JSON.stringify({ descriptor: "nope", code: "x" }),
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Descriptor must be a JSON object/);
  });
});
