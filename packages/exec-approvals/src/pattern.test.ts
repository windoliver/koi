import { describe, expect, test } from "bun:test";
import {
  defaultExtractCommand,
  findFirstAskMatch,
  matchesAnyCompound,
  matchesCompoundPattern,
  normalizePattern,
} from "./pattern.js";

// ---------------------------------------------------------------------------
// normalizePattern
// ---------------------------------------------------------------------------

describe("normalizePattern", () => {
  test("leaves patterns without ** unchanged", () => {
    expect(normalizePattern("bash")).toBe("bash");
    expect(normalizePattern("bash:git push*")).toBe("bash:git push*");
    expect(normalizePattern("*")).toBe("*");
  });

  test("replaces ** with *", () => {
    expect(normalizePattern("bash:**")).toBe("bash:*");
    expect(normalizePattern("**")).toBe("*");
    expect(normalizePattern("bash:git **")).toBe("bash:git *");
  });

  test("replaces multiple ** occurrences", () => {
    expect(normalizePattern("**:**")).toBe("*:*");
  });
});

// ---------------------------------------------------------------------------
// defaultExtractCommand
// ---------------------------------------------------------------------------

describe("defaultExtractCommand", () => {
  test("returns input.command when present", () => {
    expect(defaultExtractCommand({ command: "cat /etc/passwd" })).toBe("cat /etc/passwd");
  });

  test("joins input.args array when no command", () => {
    expect(defaultExtractCommand({ args: ["git", "push", "origin", "main"] })).toBe(
      "git push origin main",
    );
  });

  test("falls back to JSON.stringify when neither command nor args", () => {
    const input = { path: "/etc/shadow" };
    expect(defaultExtractCommand(input)).toBe(JSON.stringify(input));
  });

  test("uses command over args when both present", () => {
    expect(defaultExtractCommand({ command: "explicit", args: ["ignored"] })).toBe("explicit");
  });

  test("handles empty object", () => {
    expect(defaultExtractCommand({})).toBe("{}");
  });

  test("handles empty args array", () => {
    expect(defaultExtractCommand({ args: [] })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// matchesCompoundPattern — no-colon patterns (tool-only)
// ---------------------------------------------------------------------------

describe("matchesCompoundPattern — tool-only patterns", () => {
  const extract = defaultExtractCommand;

  test("exact tool name matches", () => {
    expect(matchesCompoundPattern("bash", "bash", {}, extract)).toBe(true);
  });

  test("exact tool name does NOT match different tool", () => {
    expect(matchesCompoundPattern("bash", "zsh", {}, extract)).toBe(false);
  });

  test("'*' pattern matches any tool regardless of input", () => {
    expect(matchesCompoundPattern("*", "bash", { command: "rm -rf /" }, extract)).toBe(true);
    expect(matchesCompoundPattern("*", "anything", {}, extract)).toBe(true);
  });

  test("tool prefix wildcard (no colon) matches tools with that prefix", () => {
    // "fs*" (no colon) → matchesSegment on toolId → prefix match
    expect(matchesCompoundPattern("fs*", "fs:read", {}, extract)).toBe(true);
    expect(matchesCompoundPattern("fs*", "fs:write", {}, extract)).toBe(true);
    expect(matchesCompoundPattern("fs*", "db:query", {}, extract)).toBe(false);
  });

  test("'fs:*' is a compound pattern — matches tool 'fs' with any input (NOT tool 'fs:read')", () => {
    // "fs:*" → toolPattern="fs", inputPattern="*" → only matches toolId exactly "fs"
    expect(matchesCompoundPattern("fs:*", "fs", { command: "anything" }, extract)).toBe(true);
    expect(matchesCompoundPattern("fs:*", "fs:read", {}, extract)).toBe(false);
  });

  test("no-colon pattern matches any input for that tool", () => {
    expect(matchesCompoundPattern("bash", "bash", { command: "cat /etc/shadow" }, extract)).toBe(
      true,
    );
    expect(matchesCompoundPattern("bash", "bash", { command: "ls" }, extract)).toBe(true);
    expect(matchesCompoundPattern("bash", "bash", {}, extract)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesCompoundPattern — compound patterns (tool:input)
// ---------------------------------------------------------------------------

describe("matchesCompoundPattern — compound patterns", () => {
  const extract = defaultExtractCommand;

  test("colon in pattern separates tool from input", () => {
    expect(matchesCompoundPattern("bash:ls", "bash", { command: "ls" }, extract)).toBe(true);
  });

  test("FIRST colon only is separator — colon in value is NOT a second separator", () => {
    // Pattern "bash:cat /etc:shadow" → toolPattern="bash", inputPattern="cat /etc:shadow"
    expect(
      matchesCompoundPattern(
        "bash:cat /etc:shadow",
        "bash",
        { command: "cat /etc:shadow" },
        extract,
      ),
    ).toBe(true);
    // Should NOT match partial command
    expect(
      matchesCompoundPattern("bash:cat /etc:shadow", "bash", { command: "cat /etc" }, extract),
    ).toBe(false);
  });

  test("input wildcard 'bash:*' matches bash with any input", () => {
    expect(matchesCompoundPattern("bash:*", "bash", { command: "ls" }, extract)).toBe(true);
    expect(matchesCompoundPattern("bash:*", "bash", {}, extract)).toBe(true);
    expect(matchesCompoundPattern("bash:*", "zsh", { command: "ls" }, extract)).toBe(false);
  });

  test("prefix input pattern matches prefixed commands", () => {
    expect(
      matchesCompoundPattern(
        "bash:git push*",
        "bash",
        { command: "git push origin main" },
        extract,
      ),
    ).toBe(true);
    expect(matchesCompoundPattern("bash:git push*", "bash", { command: "git push" }, extract)).toBe(
      true,
    );
  });

  test("prefix input pattern does NOT match other commands", () => {
    expect(
      matchesCompoundPattern("bash:git push*", "bash", { command: "git checkout" }, extract),
    ).toBe(false);
  });

  test("ECS token format: 'tool:calculator' treated as toolId='tool', inputPattern='calculator'", () => {
    // Documented behavior: the first colon separates tool from input
    expect(
      matchesCompoundPattern("tool:calculator", "tool", { command: "calculator" }, extract),
    ).toBe(true);
    expect(matchesCompoundPattern("tool:calculator", "tool:calculator", {}, extract)).toBe(false); // "tool:calculator" as toolId doesn't match toolPattern="tool"
  });

  test("input match fails when extracted command doesn't match", () => {
    expect(matchesCompoundPattern("bash:cat", "bash", { command: "ls" }, extract)).toBe(false);
  });

  test("uses args fallback when command field absent", () => {
    expect(
      matchesCompoundPattern("bash:git push", "bash", { args: ["git", "push"] }, extract),
    ).toBe(true);
  });

  test("uses JSON.stringify fallback when neither command nor args", () => {
    const input = { path: "/etc/shadow" };
    const jsonStr = JSON.stringify(input);
    expect(matchesCompoundPattern(`bash:${jsonStr}`, "bash", input, extract)).toBe(true);
  });

  test("multiple colons in input value — only first colon is separator", () => {
    const pattern = "bash:a:b:c";
    // toolPattern="bash", inputPattern="a:b:c"
    expect(matchesCompoundPattern(pattern, "bash", { command: "a:b:c" }, extract)).toBe(true);
    expect(matchesCompoundPattern(pattern, "bash", { command: "a:b" }, extract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesAnyCompound
// ---------------------------------------------------------------------------

describe("matchesAnyCompound", () => {
  const extract = defaultExtractCommand;

  test("returns true if any pattern matches", () => {
    expect(matchesAnyCompound(["calc", "bash"], "bash", {}, extract)).toBe(true);
  });

  test("returns false if no pattern matches", () => {
    expect(matchesAnyCompound(["calc", "zsh"], "bash", {}, extract)).toBe(false);
  });

  test("returns false for empty patterns list", () => {
    expect(matchesAnyCompound([], "bash", {}, extract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findFirstAskMatch
// ---------------------------------------------------------------------------

describe("findFirstAskMatch", () => {
  const extract = defaultExtractCommand;

  test("returns matched pattern string", () => {
    expect(
      findFirstAskMatch(["bash:git push*"], "bash", { command: "git push origin" }, extract),
    ).toBe("bash:git push*");
  });

  test("returns undefined when no match", () => {
    expect(
      findFirstAskMatch(["bash:git push*"], "bash", { command: "ls" }, extract),
    ).toBeUndefined();
  });

  test("returns first matching pattern", () => {
    const patterns = ["bash:git*", "bash:git push*"];
    // First match wins
    expect(findFirstAskMatch(patterns, "bash", { command: "git push" }, extract)).toBe("bash:git*");
  });

  test("returns undefined for empty patterns list", () => {
    expect(findFirstAskMatch([], "bash", {}, extract)).toBeUndefined();
  });
});
