import { describe, expect, test } from "bun:test";
import { substituteVariables } from "./substitute.js";

// biome-ignore lint/suspicious/noTemplateCurlyInString: tests use literal ${VAR} patterns
const ARGS = "${ARGS}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: tests use literal ${VAR} patterns
const SKILL_DIR = "${SKILL_DIR}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: tests use literal ${VAR} patterns
const SESSION_ID = "${SESSION_ID}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: tests use literal ${VAR} patterns
const UNKNOWN = "${UNKNOWN}";

describe("substituteVariables", () => {
  test("substitutes ARGS with provided args", () => {
    const result = substituteVariables(`Run: ${ARGS}`, {
      args: "build --watch",
      skillDir: "/skills/test",
    });
    expect(result).toBe("Run: build --watch");
  });

  test("substitutes SKILL_DIR with skill directory path", () => {
    const result = substituteVariables(`Dir: ${SKILL_DIR}/schema.json`, {
      skillDir: "/home/user/.claude/skills/my-skill",
    });
    expect(result).toBe("Dir: /home/user/.claude/skills/my-skill/schema.json");
  });

  test("substitutes SESSION_ID with session identifier", () => {
    const result = substituteVariables(`Session: ${SESSION_ID}`, {
      skillDir: "/skills/test",
      sessionId: "abc-123",
    });
    expect(result).toBe("Session: abc-123");
  });

  test("leaves ARGS and SESSION_ID as-is when not provided", () => {
    const result = substituteVariables(`args=[${ARGS}] session=[${SESSION_ID}]`, {
      skillDir: "/skills/test",
    });
    expect(result).toBe(`args=[${ARGS}] session=[${SESSION_ID}]`);
  });

  test("leaves unknown variable patterns as-is", () => {
    const result = substituteVariables(`${UNKNOWN} and ${ARGS}`, {
      args: "test",
      skillDir: "/skills/test",
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal output
    expect(result).toBe("${UNKNOWN} and test");
  });

  test("returns body unchanged when no patterns present", () => {
    const body = "No variables here, just text.";
    const result = substituteVariables(body, { skillDir: "/skills/test" });
    expect(result).toBe(body);
  });

  test("handles multiple occurrences of the same variable", () => {
    const result = substituteVariables(`${ARGS} then ${ARGS}`, {
      args: "x",
      skillDir: "/skills/test",
    });
    expect(result).toBe("x then x");
  });
});
