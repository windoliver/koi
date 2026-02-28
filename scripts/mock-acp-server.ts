#!/usr/bin/env bun
/**
 * Mock ACP server for @koi/engine-acp E2E testing.
 *
 * Implements ACP v0.10.x (JSON-RPC 2.0 over stdin/stdout).
 * Does NOT make real LLM calls — all responses are deterministic.
 *
 * Special prompt triggers (include the keyword in the prompt text):
 *   "READ_FILE:<path>"      → sends fs/read_text_file callback to Koi, includes contents
 *   "RUN_CMD:<cmd>:<arg>"   → sends terminal/create + wait_for_exit + output + release
 *   "REQUEST_PERMISSION"    → sends session/request_permission (expects allow outcome)
 *
 * Usage: bun scripts/mock-acp-server.ts
 */

const decoder = new TextDecoder();

// let: line buffer for incomplete stdin lines
let lineBuffer = "";
// let: session counter for generating unique IDs
let sessionCounter = 0;
// let: outbound request ID counter
let nextOutboundId = 100;

// Pending outbound requests (id → resolver)
const pendingOutbound = new Map<
  number,
  {
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: Error) => void;
  }
>();

function sendLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respond(id: unknown, result: unknown): void {
  sendLine({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  sendLine({ jsonrpc: "2.0", method, params });
}

function sendOutbound(method: string, params: unknown): Promise<unknown> {
  const id = nextOutboundId++;
  return new Promise<unknown>((resolve, reject) => {
    pendingOutbound.set(id, { resolve, reject: (e: Error) => reject(e) });
    sendLine({ jsonrpc: "2.0", id, method, params });
  });
}

async function handleSessionPrompt(
  msgId: unknown,
  sessionId: string,
  promptText: string,
): Promise<void> {
  // ----------------------------------------------------------------
  // Trigger: fs/read_text_file callback
  // All ACP callback params include sessionId per ACP v0.10.x spec.
  // ----------------------------------------------------------------
  const readMatch = /READ_FILE:(\S+)/.exec(promptText);
  if (readMatch !== null) {
    const filePath = readMatch[1];
    try {
      const result = await sendOutbound("fs/read_text_file", { sessionId, path: filePath });
      const content = (result as { content?: string }).content ?? "(empty)";
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `file:${content.slice(0, 60)}` }],
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `read-error:${msg}` }],
        },
      });
    }
  }

  // ----------------------------------------------------------------
  // Trigger: terminal/* callbacks
  // ----------------------------------------------------------------
  const cmdMatch = /RUN_CMD:(\S+)/.exec(promptText);
  if (cmdMatch !== null) {
    const parts = cmdMatch[1].split(":");
    const command = parts[0] ?? "echo";
    const args = parts.slice(1);
    try {
      const termResult = await sendOutbound("terminal/create", { sessionId, command, args });
      const terminalId = (termResult as { terminalId: string }).terminalId;
      await sendOutbound("terminal/wait_for_exit", { sessionId, terminalId });
      const outResult = await sendOutbound("terminal/output", { sessionId, terminalId });
      const outputText = (outResult as { output?: string }).output ?? "";
      await sendOutbound("terminal/release", { sessionId, terminalId });
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `cmd-output:${outputText.trim().slice(0, 60)}` }],
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `cmd-error:${msg}` }],
        },
      });
    }
  }

  // ----------------------------------------------------------------
  // Trigger: session/request_permission callback
  // ----------------------------------------------------------------
  if (promptText.includes("REQUEST_PERMISSION")) {
    try {
      await sendOutbound("session/request_permission", {
        sessionId,
        permissionType: "execute_bash",
        toolCall: {
          toolCallId: "mock-perm-1",
          title: "Run test command",
          kind: "execute",
          status: "pending",
        },
        options: [
          { outcome: "allow", label: "Allow", isPrimary: true },
          { outcome: "deny", label: "Deny" },
        ],
      });
    } catch {
      // Permission denied or error — continue
    }
  }

  // ----------------------------------------------------------------
  // Standard response: stream text in chunks
  // ----------------------------------------------------------------
  const responseText = `mock-acp:${promptText.slice(0, 32).replace(/\s+/g, "_")}`;
  const chunkSize = 6;
  for (let i = 0; i < responseText.length; i += chunkSize) {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: responseText.slice(i, i + chunkSize) }],
      },
    });
    await Bun.sleep(5);
  }

  // Send session/prompt completion
  respond(msgId, {
    stopReason: "end_turn",
    usage: {
      inputTokens: Math.max(10, promptText.length),
      outputTokens: responseText.length,
    },
  });
}

async function handleMessage(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const m = msg as Record<string, unknown>;

  // Route responses to pending outbound requests
  if (typeof m.method !== "string" && m.id !== undefined) {
    const id = m.id as number;
    const pending = pendingOutbound.get(id);
    if (pending !== undefined) {
      pendingOutbound.delete(id);
      if (m.error !== undefined) {
        const errObj = m.error as Record<string, unknown>;
        pending.reject(new Error(String(errObj.message ?? m.error)));
      } else {
        pending.resolve(m.result);
      }
    }
    return;
  }

  const id = m.id;
  const method = m.method as string;
  const params = m.params;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: "mock-acp-server", version: "0.0.1" },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcp: { http: false, sse: false },
        },
      });
      break;

    case "session/new":
      sessionCounter++;
      respond(id, { sessionId: `mock-session-${sessionCounter}` });
      break;

    case "session/prompt": {
      const p = params as {
        readonly sessionId: string;
        readonly prompt?: ReadonlyArray<{ readonly text?: string }>;
      };
      const promptText = p.prompt?.map((b) => b.text ?? "").join("") ?? "";
      // Fire-and-forget — allows the stdin loop to continue receiving messages
      void handleSessionPrompt(id, p.sessionId, promptText);
      break;
    }

    default:
      sendLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// ---------------------------------------------------------------------------
// Main: read stdin line-by-line and dispatch
// ---------------------------------------------------------------------------

for await (const chunk of process.stdin) {
  lineBuffer += decoder.decode(chunk, { stream: true });
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    void handleMessage(line);
  }
}

// Flush remaining buffer
if (lineBuffer.trim().length > 0) {
  void handleMessage(lineBuffer);
}
