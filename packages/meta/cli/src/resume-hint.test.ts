import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { decideResumeHint, formatPickerModeResumeHint, formatResumeHint } from "./resume-hint.js";

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

describe("formatPickerModeResumeHint", () => {
  test("surfaces both writable and viewed ids", () => {
    const writable = sessionId("aaaaaaaa-0000-0000-0000-000000000000");
    const viewed = sessionId("bbbbbbbb-1111-1111-1111-111111111111");
    const hint = formatPickerModeResumeHint(writable, viewed);
    expect(hint).toContain("koi tui --resume aaaaaaaa-0000-0000-0000-000000000000");
    expect(hint).toContain("koi tui --resume bbbbbbbb-1111-1111-1111-111111111111");
    expect(hint).toContain("writable");
    expect(hint).toContain("archive");
  });

  test("shell-quotes both ids independently", () => {
    const writable = sessionId("a safe-one");
    const viewed = sessionId("b;rm -rf /");
    const hint = formatPickerModeResumeHint(writable, viewed);
    expect(hint).toContain("koi tui --resume 'a safe-one'");
    expect(hint).toContain("koi tui --resume 'b;rm -rf /'");
  });
});

describe("decideResumeHint", () => {
  const sid = sessionId("s-1");
  const other = sessionId("s-2");
  const base = {
    clearPersistFailed: false,
    clearedThisProcess: false,
    resumedFromFlag: false,
    postClearTurnCount: 0,
    anyTurnPersistedThisProcess: false,
    tuiSessionId: sid,
    viewedSessionId: sid,
  } as const;

  test("#1884: fresh launch + zero turns + no --resume → never-persisted (silent)", () => {
    expect(decideResumeHint(base).kind).toBe("never-persisted");
  });

  test("#1884: fresh launch + ≥1 settled turn → normal hint", () => {
    // postClearTurnCount stays 0 on fresh launch because rewindBoundaryActive
    // is false; the real signal is anyTurnPersistedThisProcess.
    expect(decideResumeHint({ ...base, anyTurnPersistedThisProcess: true }).kind).toBe("normal");
  });

  test("--resume + zero new turns → normal hint (the resumed file already exists)", () => {
    expect(decideResumeHint({ ...base, resumedFromFlag: true }).kind).toBe("normal");
  });

  test("--resume + ≥1 new turn → normal hint", () => {
    expect(
      decideResumeHint({
        ...base,
        resumedFromFlag: true,
        postClearTurnCount: 2,
        anyTurnPersistedThisProcess: true,
      }).kind,
    ).toBe("normal");
  });

  test("/clear + zero turns → cleared-empty (explicit stderr notice)", () => {
    expect(
      decideResumeHint({ ...base, clearedThisProcess: true, postClearTurnCount: 0 }).kind,
    ).toBe("cleared-empty");
  });

  test("/clear + ≥1 turn afterwards → normal hint (there's new work to resume)", () => {
    expect(
      decideResumeHint({
        ...base,
        clearedThisProcess: true,
        postClearTurnCount: 1,
        anyTurnPersistedThisProcess: true,
      }).kind,
    ).toBe("normal");
  });

  test("clear persist failed → clear-persist-failed (stderr warning)", () => {
    expect(decideResumeHint({ ...base, clearPersistFailed: true }).kind).toBe(
      "clear-persist-failed",
    );
  });

  test("picker mode: viewed archive differs from writable session → picker hint", () => {
    expect(
      decideResumeHint({
        ...base,
        anyTurnPersistedThisProcess: true, // past never-persisted guard
        viewedSessionId: other,
      }).kind,
    ).toBe("picker");
  });

  test("clear-persist-failed takes precedence over every other flag", () => {
    expect(
      decideResumeHint({
        ...base,
        clearPersistFailed: true,
        clearedThisProcess: true,
        resumedFromFlag: true,
        postClearTurnCount: 3,
        anyTurnPersistedThisProcess: true,
        viewedSessionId: other,
      }).kind,
    ).toBe("clear-persist-failed");
  });
});
