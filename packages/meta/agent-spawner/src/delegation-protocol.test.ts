import { describe, expect, test } from "bun:test";
import type { KoiErrorCode, SandboxAdapterResult } from "@koi/core";
import {
  buildAcpArgs,
  buildAcpStdin,
  buildStdioArgs,
  extractAcpOutput,
  parseStdioOutput,
} from "./delegation-protocol.js";

// ---------------------------------------------------------------------------
// buildStdioArgs
// ---------------------------------------------------------------------------

describe("buildStdioArgs", () => {
  test("builds args without model", () => {
    const args = buildStdioArgs("claude", "fix the bug");
    expect(args).toEqual(["claude", "--print", "fix the bug"]);
  });

  test("builds args with model", () => {
    const args = buildStdioArgs("claude", "fix the bug", "opus");
    expect(args).toEqual(["claude", "--print", "fix the bug", "--model", "opus"]);
  });
});

// ---------------------------------------------------------------------------
// parseStdioOutput — table-driven
// ---------------------------------------------------------------------------

describe("parseStdioOutput", () => {
  const base: SandboxAdapterResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 100,
    timedOut: false,
    oomKilled: false,
  };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: SandboxAdapterResult;
    readonly ok: boolean;
    readonly value?: string;
    readonly errorCode?: KoiErrorCode;
  }> = [
    {
      name: "happy path — returns trimmed stdout",
      input: { ...base, stdout: "  fixed the bug  " },
      ok: true,
      value: "fixed the bug",
    },
    {
      name: "empty output — returns PARSE_FAILED error",
      input: { ...base, stdout: "" },
      ok: false,
      errorCode: "EXTERNAL",
    },
    {
      name: "whitespace-only output — returns PARSE_FAILED error",
      input: { ...base, stdout: "   \n\t  " },
      ok: false,
      errorCode: "EXTERNAL",
    },
    {
      name: "non-zero exit — returns SPAWN_FAILED error",
      input: { ...base, exitCode: 1, stderr: "command not found" },
      ok: false,
      errorCode: "EXTERNAL",
    },
    {
      name: "timeout with no output — returns TIMEOUT error",
      input: { ...base, timedOut: true },
      ok: false,
      errorCode: "TIMEOUT",
    },
    {
      name: "timeout with partial output — returns partial output as success",
      input: { ...base, timedOut: true, stdout: "partial result" },
      ok: true,
      value: "partial result",
    },
    {
      name: "unicode content preserved",
      input: { ...base, stdout: "const emoji = '🎯';" },
      ok: true,
      value: "const emoji = '🎯';",
    },
    {
      name: "leading/trailing newlines trimmed",
      input: { ...base, stdout: "\n\nresult\n\n" },
      ok: true,
      value: "result",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = parseStdioOutput(c.input);
      expect(result.ok).toBe(c.ok);
      if (c.ok && result.ok && c.value !== undefined) {
        expect(result.value).toBe(c.value);
      }
      if (!c.ok && !result.ok && c.errorCode !== undefined) {
        expect(result.error.code).toBe(c.errorCode);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// buildAcpArgs
// ---------------------------------------------------------------------------

describe("buildAcpArgs", () => {
  test("builds args without model", () => {
    expect(buildAcpArgs("claude")).toEqual(["claude", "--acp"]);
  });

  test("builds args with model", () => {
    expect(buildAcpArgs("claude", "opus")).toEqual(["claude", "--acp", "--model", "opus"]);
  });
});

// ---------------------------------------------------------------------------
// buildAcpStdin
// ---------------------------------------------------------------------------

describe("buildAcpStdin", () => {
  test("produces three JSON-RPC lines", () => {
    const stdin = buildAcpStdin("fix this");
    const lines = stdin.trim().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(typeof parsed.id).toBe("number");
    }
  });

  test("third line contains the prompt", () => {
    const stdin = buildAcpStdin("implement feature X");
    const lines = stdin.trim().split("\n");
    const lastLine = lines[2] ?? "";
    const parsed = JSON.parse(lastLine);
    expect(parsed.method).toBe("session/prompt");
    expect(parsed.params.messages[0].content).toBe("implement feature X");
  });
});

// ---------------------------------------------------------------------------
// extractAcpOutput
// ---------------------------------------------------------------------------

describe("extractAcpOutput", () => {
  function makeNotification(text: string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        content: [{ type: "text", text }],
      },
    });
  }

  test("extracts text from session/update notifications", () => {
    const stdout = [makeNotification("Hello "), makeNotification("world")].join("\n");

    const result = extractAcpOutput(stdout);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello world");
    }
  });

  test("returns error for empty output", () => {
    const result = extractAcpOutput("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }
  });

  test("returns error for whitespace-only text", () => {
    const stdout = makeNotification("   ");
    const result = extractAcpOutput(stdout);
    expect(result.ok).toBe(false);
  });

  test("ignores non-session/update notifications", () => {
    const stdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/started",
      params: { sessionId: "abc" },
    });
    const result = extractAcpOutput(stdout);
    expect(result.ok).toBe(false);
  });
});
