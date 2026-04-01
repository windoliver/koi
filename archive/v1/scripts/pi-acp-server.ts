#!/usr/bin/env bun

/**
 * Pi-backed ACP server for @koi/engine-acp live E2E testing.
 *
 * A real ACP v0.10.x (JSON-RPC 2.0 over stdin/stdout) agent subprocess that
 * uses createPiAdapter + createKoi for actual LLM inference. The agent has a
 * `bash` tool that delegates execution to Koi via ACP terminal/* callbacks,
 * making it a Pi-powered coding agent.
 *
 * Requires: ANTHROPIC_API_KEY in the environment.
 *
 * Usage (direct): bun scripts/pi-acp-server.ts
 * Usage (via E2E): spawned by createAcpAdapter in e2e-engine-acp.ts
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import { createSingleToolProvider } from "../packages/kernel/core/src/create-single-tool-provider.js";
import type { Tool } from "../packages/kernel/core/src/ecs.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import type { KoiRuntime } from "../packages/kernel/engine/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  process.stderr.write("[pi-acp-server] ANTHROPIC_API_KEY not set\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();
// let: partial line buffer
let lineBuffer = "";
// let: session counter for unique IDs
let sessionCounter = 0;
// let: outbound request ID counter
let nextOutboundId = 100;

/** Map of sessionId → KoiRuntime (one per ACP session). */
const sessions = new Map<string, KoiRuntime>();

/** Pending outbound requests (id → resolver). */
const pendingOutbound = new Map<
  number,
  {
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: Error) => void;
  }
>();

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function sendLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respond(id: unknown, result: unknown): void {
  sendLine({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  sendLine({ jsonrpc: "2.0", method, params });
}

/** Send an outbound JSON-RPC request to Koi and await the response. */
function sendOutbound(method: string, params: unknown): Promise<unknown> {
  const id = nextOutboundId++;
  return new Promise<unknown>((resolve, reject) => {
    pendingOutbound.set(id, { resolve, reject: (e: Error) => reject(e) });
    sendLine({ jsonrpc: "2.0", id, method, params });
  });
}

function mapKoiStop(reason: string): string {
  switch (reason) {
    case "completed":
      return "end_turn";
    case "max_turns":
      return "max_iterations";
    case "interrupted":
      return "cancelled";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Bash tool provider (scoped per ACP session)
//
// The bash tool delegates to Koi's terminal/* callbacks, giving the Pi LLM
// real code execution power via the headless IDE contract.
// ---------------------------------------------------------------------------

function createBashProvider(acpSessionId: string): ReturnType<typeof createSingleToolProvider> {
  return createSingleToolProvider({
    name: "bash-provider",
    toolName: "bash",
    createTool: (): Tool => ({
      descriptor: {
        name: "bash",
        description:
          "Execute a shell command and return its combined stdout+stderr output. " +
          "Use this to run commands, inspect the filesystem, check system state, etc.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to run (executed via /bin/sh -c)",
            },
          },
          required: ["command"],
        },
      },
      trustTier: "sandbox",
      execute: async (args): Promise<unknown> => {
        const cmd = typeof args.command === "string" ? args.command : "";

        // 1. Create a terminal subprocess via Koi's headless IDE
        const termResult = await sendOutbound("terminal/create", {
          sessionId: acpSessionId,
          command: "/bin/sh",
          args: ["-c", cmd],
        });
        const terminalId = (termResult as { readonly terminalId: string }).terminalId;

        // 2. Wait for the process to exit
        await sendOutbound("terminal/wait_for_exit", { sessionId: acpSessionId, terminalId });

        // 3. Collect output
        const outResult = await sendOutbound("terminal/output", {
          sessionId: acpSessionId,
          terminalId,
        });
        const output = (outResult as { readonly output?: string }).output ?? "";

        // 4. Release the terminal
        await sendOutbound("terminal/release", { sessionId: acpSessionId, terminalId });

        return output;
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

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

  // Route responses to pending outbound requests (no method field = it's a response)
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

  const method = m.method as string | undefined;
  const id = m.id;
  const params = m.params;

  // Only process inbound requests (method present)
  if (method === undefined) return;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: "pi-acp-server", version: "0.0.1" },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      break;

    case "session/new": {
      sessionCounter++;
      const sessionId = `pi-session-${sessionCounter}`;

      const adapter = createPiAdapter({
        model: "anthropic:claude-haiku-4-5-20251001",
        systemPrompt:
          "You are a coding assistant. You have a bash tool to execute shell commands. " +
          "When asked to run a command, use the bash tool and report the exact output. " +
          "Reply concisely.",
        getApiKey: async () => API_KEY,
      });

      const koi = await createKoi({
        manifest: {
          name: "pi-acp-agent",
          version: "0.0.1",
          model: { name: "anthropic:claude-haiku-4-5-20251001" },
        },
        adapter,
        providers: [createBashProvider(sessionId)],
        limits: { maxTurns: 5, maxDurationMs: 120_000, maxTokens: 50_000 },
      });

      sessions.set(sessionId, koi);
      respond(id, { sessionId });
      break;
    }

    case "session/prompt": {
      const p = params as {
        readonly sessionId: string;
        readonly prompt?: ReadonlyArray<{ readonly text?: string }>;
      };
      const koi = sessions.get(p.sessionId);

      if (koi === undefined) {
        sendLine({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown session: ${p.sessionId}` },
        });
        return;
      }

      const promptText = p.prompt?.map((b) => b.text ?? "").join("") ?? "";

      // Fire-and-forget — the stdin loop must keep running for the ACP client to
      // receive notifications and for any future requests to arrive.
      void (async () => {
        let acpStopReason = "end_turn";
        let inputTokens = 0;
        let outputTokens = 0;

        for await (const event of koi.run({ kind: "text", text: promptText })) {
          if (event.kind === "text_delta") {
            notify("session/update", {
              sessionId: p.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: [{ type: "text", text: event.delta }],
              },
            });
          }
          if (event.kind === "done") {
            acpStopReason = mapKoiStop(event.output.stopReason);
            inputTokens = event.output.metrics.inputTokens;
            outputTokens = event.output.metrics.outputTokens;
          }
        }

        respond(id, {
          stopReason: acpStopReason,
          usage: { inputTokens, outputTokens },
        });
      })();
      break;
    }

    default:
      sendLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
  }
}

// ---------------------------------------------------------------------------
// Main: stdin line loop
// ---------------------------------------------------------------------------

for await (const chunk of process.stdin) {
  lineBuffer += decoder.decode(chunk, { stream: true });
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    // Fire-and-forget each message so stdin keeps flowing while sessions stream
    void handleMessage(line);
  }
}

// Flush any remaining partial line
if (lineBuffer.trim().length > 0) {
  void handleMessage(lineBuffer);
}

// Dispose all open sessions on exit
for (const koi of sessions.values()) {
  await koi.dispose();
}
