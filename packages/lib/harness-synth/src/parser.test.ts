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

  test("recovers when an earlier unmatched `{` precedes the payload", () => {
    const real = rawWith(VALID_DESCRIPTOR, "x();");
    const wrapped = `Example: { incomplete\n${real}`;
    const result = parseSynthesisOutput(wrapped, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("x();");
  });

  test("rejects ambiguous output containing two claimant payloads", () => {
    const example = rawWith(VALID_DESCRIPTOR, "old();");
    const real = rawWith(VALID_DESCRIPTOR, "fixed();");
    const result = parseSynthesisOutput(
      `Earlier example: ${example}\n\nReal answer: ${real}`,
      "echo_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/2 claimant payloads/);
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

  test("does not misclassify nested properties.{descriptor, code} as a claimant", () => {
    // A perfectly valid target schema may expose `descriptor` and `code`
    // fields (e.g. a schema-edit tool). The parser must look at the
    // top-level payload only, not at nested schema property objects.
    const out = JSON.stringify({
      descriptor: {
        name: "echo_tool",
        description: "ok",
        inputSchema: {
          type: "object",
          properties: {
            descriptor: { type: "object" },
            code: { type: "string" },
          },
        },
      },
      code: "x();",
    });
    const result = parseSynthesisOutput(out, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("x();");
  });

  test("linear-time on deeply nested valid JSON (no quadratic re-parse)", () => {
    // 1000 levels of nesting, all valid. Old per-pop JSON.parse would
    // re-parse 1000 growing prefixes (~quadratic). New scan parses only
    // outermost matched span once.
    const depth = 500;
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < depth; i += 1) nested = { n: nested };
    const out = JSON.stringify({
      descriptor: {
        name: "echo_tool",
        description: "ok",
        inputSchema: { type: "object", nested },
      },
      code: "x();",
    });
    const start = Date.now();
    const result = parseSynthesisOutput(out, "echo_tool");
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test("linear-time on brace-heavy malformed output (no quadratic blowup)", () => {
    // Worst case for the OLD parser: a long run of unmatched `{` would
    // re-scan the suffix from each one. With the linear stack-based scan,
    // 200k unmatched braces should finish in well under a second.
    const malformed = "{".repeat(200_000);
    const start = Date.now();
    const result = parseSynthesisOutput(malformed, "echo_tool");
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  test("recovers when prose has single-quoted braces before real payload", () => {
    const real = JSON.stringify({
      descriptor: VALID_DESCRIPTOR,
      code: "export const run = (x) => x;",
    });
    const raw = `Example: {'descriptor': stuff, 'code': '...'}\n\nActual:\n${real}`;
    const result = parseSynthesisOutput(raw, "echo_tool");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor.name).toBe("echo_tool");
  });
});
