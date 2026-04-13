import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { formatResumeHint } from "./resume-hint.js";

describe("formatResumeHint", () => {
  test("includes the session id verbatim", () => {
    const id = sessionId("cf61a663-0c88-4a37-8590-700aa7f6f5d0");
    const hint = formatResumeHint(id);
    expect(hint).toContain("cf61a663-0c88-4a37-8590-700aa7f6f5d0");
  });

  test("uses `koi tui --resume` as the resume command", () => {
    const id = sessionId("abc");
    expect(formatResumeHint(id)).toContain("koi tui --resume abc");
  });

  test("leads with a blank line and a human-readable prompt", () => {
    const id = sessionId("x");
    const hint = formatResumeHint(id);
    expect(hint.startsWith("\n")).toBe(true);
    expect(hint).toContain("Resume this session with:");
  });

  test("terminates with a newline so it does not butt up against the shell prompt", () => {
    const id = sessionId("x");
    expect(formatResumeHint(id).endsWith("\n")).toBe(true);
  });

  test("leaves plain UUIDs unquoted (shell-safe)", () => {
    const id = sessionId("cf61a663-0c88-4a37-8590-700aa7f6f5d0");
    expect(formatResumeHint(id)).toContain(
      "koi tui --resume cf61a663-0c88-4a37-8590-700aa7f6f5d0\n",
    );
  });

  test("shell-quotes ids containing metacharacters", () => {
    // Session picker can load user-controlled session files; their
    // names flow into the hint verbatim. Anything outside the
    // whitelist must become one single-quoted shell token so a
    // copy-paste cannot execute extra syntax.
    const id = sessionId("foo; rm -rf /");
    const hint = formatResumeHint(id);
    expect(hint).toContain("koi tui --resume 'foo; rm -rf /'\n");
  });

  test("escapes embedded single quotes via the canonical '\"'\"' dance", () => {
    const id = sessionId("a'b");
    const hint = formatResumeHint(id);
    expect(hint).toContain("koi tui --resume 'a'\"'\"'b'\n");
  });

  test("shell-quotes whitespace and backtick-bearing ids", () => {
    const id = sessionId("has space `pwd`");
    const hint = formatResumeHint(id);
    expect(hint).toContain("koi tui --resume 'has space `pwd`'\n");
  });
});
