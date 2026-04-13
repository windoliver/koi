import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { formatResumeHint } from "./resume-hint.js";

describe("formatResumeHint", () => {
  test("includes the session id verbatim", () => {
    const id = sessionId("cf61a663-0c88-4a37-8590-700aa7f6f5d0");
    const hint = formatResumeHint(id);
    expect(hint).toContain("cf61a663-0c88-4a37-8590-700aa7f6f5d0");
  });

  test("uses `koi start --resume` as the resume command", () => {
    const id = sessionId("abc");
    expect(formatResumeHint(id)).toContain("koi start --resume abc");
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
});
