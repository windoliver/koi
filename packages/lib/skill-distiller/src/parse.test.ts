import { describe, expect, test } from "bun:test";
import { parseSkillDraft } from "./parse.js";

const VALID = JSON.stringify({
  name: "format-pr",
  description: "Format a PR.",
  triggers: ["format pr"],
  parameters: [{ name: "title", description: "title", required: true }],
  toolSequence: ["read_file", "write_file"],
  expectedInputs: ["pr number"],
  expectedOutputs: ["formatted markdown"],
});

describe("parseSkillDraft", () => {
  test("returns ok for valid JSON", () => {
    const r = parseSkillDraft(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("format-pr");
  });

  test("rejects malformed JSON", () => {
    const r = parseSkillDraft("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_JSON_PARSE");
  });

  test("rejects array root", () => {
    const r = parseSkillDraft("[]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_NOT_OBJECT");
  });

  test("rejects non-kebab name", () => {
    const r = parseSkillDraft(JSON.stringify({ ...JSON.parse(VALID), name: "Format PR" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_NAME_INVALID");
  });

  test("rejects empty description", () => {
    const r = parseSkillDraft(JSON.stringify({ ...JSON.parse(VALID), description: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_DESCRIPTION_INVALID");
  });

  test("rejects non-string-array triggers", () => {
    const r = parseSkillDraft(JSON.stringify({ ...JSON.parse(VALID), triggers: [1, 2] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_TRIGGERS_INVALID");
  });

  test("rejects parameter missing required boolean", () => {
    const r = parseSkillDraft(
      JSON.stringify({
        ...JSON.parse(VALID),
        parameters: [{ name: "x", description: "y" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_PARAMETER_SHAPE");
  });

  test("rejects parameters that is not an array", () => {
    const r = parseSkillDraft(JSON.stringify({ ...JSON.parse(VALID), parameters: "no" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context?.errorKind).toBe("DRAFT_PARAMETERS_NOT_ARRAY");
  });

  test("accepts empty parameters array", () => {
    const r = parseSkillDraft(JSON.stringify({ ...JSON.parse(VALID), parameters: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parameters).toEqual([]);
  });
});
