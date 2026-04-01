/**
 * Tests for ACP Zod schemas via exported parse functions.
 *
 * Schemas are module-private (isolatedDeclarations); only parse functions are public.
 * Content blocks and permission options are tested indirectly through parent schemas.
 */

import { describe, expect, test } from "bun:test";
import {
  parseAnyRpcMessage,
  parseInitializeResult,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionUpdateParams,
  safeParseFsReadTextFileParams,
  safeParseFsWriteTextFileParams,
  safeParseSessionRequestPermissionParams,
  safeParseTerminalCreateParams,
  safeParseTerminalSessionParams,
} from "./acp-schema.js";

describe("parseAnyRpcMessage", () => {
  test("accepts notification (no id)", () => {
    const msg = { jsonrpc: "2.0", method: "session/update", params: {} };
    expect(parseAnyRpcMessage(msg)).toBeDefined();
  });

  test("accepts request with id", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect(parseAnyRpcMessage(msg)).toBeDefined();
  });

  test("accepts success response", () => {
    const msg = { jsonrpc: "2.0", id: 1, result: { sessionId: "abc" } };
    expect(parseAnyRpcMessage(msg)).toBeDefined();
  });

  test("accepts error response", () => {
    const msg = { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Bad request" } };
    expect(parseAnyRpcMessage(msg)).toBeDefined();
  });

  test("rejects non-2.0 jsonrpc version", () => {
    const msg = { jsonrpc: "1.0", method: "foo" };
    expect(parseAnyRpcMessage(msg)).toBeUndefined();
  });

  test("rejects missing jsonrpc field", () => {
    const msg = { method: "foo" };
    expect(parseAnyRpcMessage(msg)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ContentBlock — tested indirectly via session/update params
// ---------------------------------------------------------------------------

describe("ContentBlock (via parseSessionUpdateParams)", () => {
  function wrapUpdate(update: unknown): unknown {
    return { sessionId: "sess_abc", update };
  }

  test("accepts text block", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: "Hello" }],
    });
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts text block with optional mimeType", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: "Hello", mimeType: "text/markdown" }],
    });
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts image block", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "image", mimeType: "image/png", data: "base64data==" }],
    });
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts resourceLink block", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "resourceLink", uri: "file:///foo.ts", mimeType: "text/plain" }],
    });
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts embedded resource block", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "resource", uri: "file:///foo.ts", mimeType: "text/plain", text: "content" },
      ],
    });
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("rejects unknown block type", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "unknown", data: "foo" }],
    });
    expect(parseSessionUpdateParams(params)).toBeUndefined();
  });

  test("rejects image block with invalid mimeType", () => {
    const params = wrapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "image", mimeType: "video/mp4", data: "base64==" }],
    });
    expect(parseSessionUpdateParams(params)).toBeUndefined();
  });
});

describe("parseInitializeResult", () => {
  test("accepts minimal result", () => {
    const result = { protocolVersion: 1 };
    expect(parseInitializeResult(result)).toBeDefined();
  });

  test("accepts full result with capabilities", () => {
    const result = {
      protocolVersion: 1,
      agentInfo: { name: "claude-code", version: "1.0.0" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
    };
    expect(parseInitializeResult(result)).toBeDefined();
  });

  test("allows extra fields (protocol forward-compat)", () => {
    const result = { protocolVersion: 1, newField: "someValue" };
    expect(parseInitializeResult(result)).toBeDefined();
  });

  test("rejects missing protocolVersion", () => {
    const result = { agentInfo: { name: "claude" } };
    expect(parseInitializeResult(result)).toBeUndefined();
  });
});

describe("parseSessionNewResult", () => {
  test("accepts valid result", () => {
    const result = { sessionId: "sess_abc123" };
    const parsed = parseSessionNewResult(result);
    expect(parsed).toBeDefined();
    expect(parsed?.sessionId).toBe("sess_abc123");
  });

  test("rejects missing sessionId", () => {
    expect(parseSessionNewResult({})).toBeUndefined();
  });
});

describe("parseSessionPromptResult", () => {
  test("accepts end_turn stop reason", () => {
    const result = { stopReason: "end_turn" };
    expect(parseSessionPromptResult(result)).toBeDefined();
  });

  test("accepts all valid stop reasons", () => {
    for (const reason of ["end_turn", "tool_call", "error", "cancelled", "max_iterations"]) {
      expect(parseSessionPromptResult({ stopReason: reason })).toBeDefined();
    }
  });

  test("accepts with usage", () => {
    const result = { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } };
    const parsed = parseSessionPromptResult(result);
    expect(parsed).toBeDefined();
    expect(parsed?.usage?.inputTokens).toBe(100);
  });

  test("rejects unknown stop reason", () => {
    const result = { stopReason: "unknown_reason" };
    expect(parseSessionPromptResult(result)).toBeUndefined();
  });
});

describe("parseSessionUpdateParams", () => {
  test("accepts agent_message_chunk", () => {
    const params = {
      sessionId: "sess_abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "Hello" }],
      },
    };
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts tool_call update", () => {
    const params = {
      sessionId: "sess_abc",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_123",
        title: "Read file",
        kind: "read",
        status: "pending",
      },
    };
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts tool_call_update notification", () => {
    const params = {
      sessionId: "sess_abc",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_123",
        status: "completed",
      },
    };
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("accepts current_mode_update", () => {
    const params = {
      sessionId: "sess_abc",
      update: { sessionUpdate: "current_mode_update", mode: "auto" },
    };
    expect(parseSessionUpdateParams(params)).toBeDefined();
  });

  test("rejects unknown sessionUpdate kind", () => {
    const params = {
      sessionId: "sess_abc",
      update: { sessionUpdate: "unknown_kind" },
    };
    expect(parseSessionUpdateParams(params)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PermissionOption — tested via safeParseSessionRequestPermissionParams
// ---------------------------------------------------------------------------

describe("PermissionOption (via safeParseSessionRequestPermissionParams)", () => {
  const baseToolCall = {
    toolCallId: "tc_1",
    title: "Write file",
    kind: "edit",
    status: "pending",
  };

  test("accepts all valid option kinds", () => {
    for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"]) {
      const result = safeParseSessionRequestPermissionParams({
        sessionId: "sess_abc",
        toolCall: baseToolCall,
        options: [{ optionId: "x", name: "Test", kind }],
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid option kind", () => {
    const result = safeParseSessionRequestPermissionParams({
      sessionId: "sess_abc",
      toolCall: baseToolCall,
      options: [{ optionId: "x", name: "Bad", kind: "invalid_kind" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("safeParseSessionRequestPermissionParams", () => {
  test("accepts valid params", () => {
    const params = {
      sessionId: "sess_abc",
      toolCall: {
        toolCallId: "tc_1",
        title: "Write file",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
    const result = safeParseSessionRequestPermissionParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe("sess_abc");
    }
  });

  test("provides error string on failure", () => {
    const result = safeParseSessionRequestPermissionParams({ bad: "data" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("safeParseFsReadTextFileParams", () => {
  test("accepts minimal params", () => {
    const params = { sessionId: "sess_abc", path: "/foo/bar.ts" };
    const result = safeParseFsReadTextFileParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe("/foo/bar.ts");
    }
  });

  test("accepts with line and limit", () => {
    const params = { sessionId: "sess_abc", path: "/foo/bar.ts", line: 10, limit: 20 };
    const result = safeParseFsReadTextFileParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line).toBe(10);
      expect(result.data.limit).toBe(20);
    }
  });

  test("rejects missing path", () => {
    const result = safeParseFsReadTextFileParams({ sessionId: "sess_abc" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("safeParseFsWriteTextFileParams", () => {
  test("accepts valid params", () => {
    const params = { sessionId: "sess_abc", path: "/foo/bar.ts", content: "hello" };
    const result = safeParseFsWriteTextFileParams(params);
    expect(result.success).toBe(true);
  });

  test("rejects missing content", () => {
    const params = { sessionId: "sess_abc", path: "/foo/bar.ts" };
    const result = safeParseFsWriteTextFileParams(params);
    expect(result.success).toBe(false);
  });
});

describe("safeParseTerminalCreateParams", () => {
  test("accepts minimal params", () => {
    const params = { sessionId: "sess_abc", command: "ls" };
    const result = safeParseTerminalCreateParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.command).toBe("ls");
    }
  });

  test("accepts full params", () => {
    const params = {
      sessionId: "sess_abc",
      command: "echo",
      args: ["hello"],
      env: [{ name: "FOO", value: "bar" }],
      cwd: "/tmp",
      outputByteLimit: 1024,
    };
    const result = safeParseTerminalCreateParams(params);
    expect(result.success).toBe(true);
  });

  test("rejects missing command", () => {
    const result = safeParseTerminalCreateParams({ sessionId: "sess_abc" });
    expect(result.success).toBe(false);
  });
});

describe("safeParseTerminalSessionParams", () => {
  test("accepts valid params", () => {
    const params = { sessionId: "sess_abc", terminalId: "term-1" };
    const result = safeParseTerminalSessionParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terminalId).toBe("term-1");
    }
  });

  test("rejects missing terminalId", () => {
    const result = safeParseTerminalSessionParams({ sessionId: "sess_abc" });
    expect(result.success).toBe(false);
  });
});
