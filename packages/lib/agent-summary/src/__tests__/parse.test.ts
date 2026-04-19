import { describe, expect, test } from "bun:test";
import { parseOutput } from "../parse.js";

const GOOD_JSON = JSON.stringify({
  goal: "ship the feature",
  status: "succeeded",
  actions: [{ kind: "tool_call", name: "Edit", paths: ["a.ts"] }],
  outcomes: ["did the thing"],
  errors: [],
  learnings: [],
});

describe("parseOutput", () => {
  test("accepts valid JSON matching the schema", () => {
    const r = parseOutput(GOOD_JSON);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.goal).toBe("ship the feature");
      expect(r.value.actions.length).toBe(1);
    }
  });

  test("rejects missing required field", () => {
    const bad = JSON.stringify({
      status: "succeeded",
      actions: [],
      outcomes: [],
      errors: [],
      learnings: [],
    });
    const r = parseOutput(bad);
    expect(r.ok).toBe(false);
  });

  test("rejects wrong type on status", () => {
    const bad = JSON.stringify({
      goal: "x",
      status: "invalid",
      actions: [],
      outcomes: [],
      errors: [],
      learnings: [],
    });
    const r = parseOutput(bad);
    expect(r.ok).toBe(false);
  });

  test("strips <analysis>…</analysis> scratchpad before parse", () => {
    const wrapped = `<analysis>thinking</analysis>${GOOD_JSON}`;
    const r = parseOutput(wrapped);
    expect(r.ok).toBe(true);
  });

  test("accepts JSON inside markdown fences", () => {
    const fenced = `\`\`\`json\n${GOOD_JSON}\n\`\`\``;
    const r = parseOutput(fenced);
    expect(r.ok).toBe(true);
  });

  test("rejects extra unknown top-level field", () => {
    const bad = JSON.stringify({ ...JSON.parse(GOOD_JSON), extra: 1 });
    const r = parseOutput(bad);
    expect(r.ok).toBe(false);
  });

  test("rejects unparseable input", () => {
    const r = parseOutput("not json");
    expect(r.ok).toBe(false);
  });
});
