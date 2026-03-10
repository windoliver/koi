/**
 * @koi/engine-acp — main adapter factory.
 *
 * Creates a long-lived ACP engine adapter (decision 14A):
 * - Spawns the agent process once on first stream() call
 * - Creates a new ACP session per stream() call
 * - Routes all inbound JSON-RPC messages via a background receive loop
 * - Pending outbound requests tracked by ID for async response matching
 */

import type { AgentCapabilities, RpcInboundRequest, RpcMessage } from "@koi/acp-protocol";
import {
  buildErrorResponse,
  buildRequest,
  buildResponse,
  createAsyncQueue,
  mapSessionUpdate,
  parseInitializeResult,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionUpdateParams,
  RPC_ERROR_CODES,
  safeParseFsReadTextFileParams,
  safeParseFsWriteTextFileParams,
  safeParseSessionRequestPermissionParams,
  safeParseTerminalCreateParams,
  safeParseTerminalSessionParams,
} from "@koi/acp-protocol";
import type {
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
} from "@koi/core";
import { resolvePermission } from "./approval-bridge.js";
import { handleReadTextFile, handleWriteTextFile } from "./fs-handlers.js";
import { createTerminalRegistry } from "./terminal-handlers.js";
import type { AcpProcess } from "./transport.js";
import { createStdioTransport } from "./transport.js";
import type { AcpAdapterConfig, AcpEngineAdapter, PendingRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGINE_ID = "acp" as const;
const DEFAULT_TIMEOUT_MS = 300_000 as const; // 5 minutes
const ACP_PROTOCOL_VERSION = 1 as const;

/**
 * ACP adapter capabilities — text only for now.
 * ACP protocol communicates via JSON-RPC text messages.
 */
const ACP_CAPABILITIES: EngineCapabilities = {
  text: true,
  images: false,
  files: false,
  audio: false,
} as const;

// ---------------------------------------------------------------------------
// Input → ACP prompt content
// ---------------------------------------------------------------------------

function inputToPromptContent(
  input: EngineInput,
): readonly { readonly type: "text"; readonly text: string }[] {
  switch (input.kind) {
    case "text":
      return [{ type: "text", text: input.text }];
    case "messages": {
      const parts: string[] = [];
      for (const msg of input.messages) {
        for (const block of msg.content) {
          if (block.kind === "text") {
            parts.push(block.text);
          }
        }
      }
      const text = parts.join("\n");
      return text.length > 0 ? [{ type: "text", text }] : [];
    }
    case "resume":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(acpReason: string): "completed" | "max_turns" | "interrupted" | "error" {
  switch (acpReason) {
    case "end_turn":
      return "completed";
    case "max_iterations":
      return "max_turns";
    case "cancelled":
      return "interrupted";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Zero metrics helper
// ---------------------------------------------------------------------------

function createZeroMetrics(durationMs: number): EngineMetrics {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 1,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ACP engine adapter (headless ACP client).
 *
 * The adapter:
 * 1. Spawns the agent process on first stream() (long-lived)
 * 2. Sends `initialize` + `session/new` once
 * 3. Per stream(): sends `session/prompt`, yields EngineEvents until done
 * 4. Handles agent callbacks: fs/*, terminal/*, session/request_permission
 */
export function createAcpAdapter(config: AcpAdapterConfig): AcpEngineAdapter {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // let: process lifecycle state
  let proc: AcpProcess | undefined;
  let transport: ReturnType<typeof createStdioTransport> | undefined;
  // let: whether initialize has been sent and acknowledged
  let initialized = false;
  // let: negotiated agent capabilities (set after initialize)
  let negotiatedCapabilities: AgentCapabilities | undefined;
  // let: current session ID (set after session/new)
  let currentSessionId: string | undefined;
  // let: lifecycle flag
  let disposed = false;
  // let: concurrency guard
  let running = false;

  // Pending outbound requests (id → Promise resolver)
  const pendingRequests = new Map<string | number | null, PendingRequest>();

  // let: current turn's event queue (set during stream(), cleared after)
  let currentQueue: ReturnType<typeof createAsyncQueue<EngineEvent>> | undefined;

  // let: current session's terminal registry (created per session/new)
  let terminalRegistry: ReturnType<typeof createTerminalRegistry> | undefined;

  // ---------------------------------------------------------------------------
  // Inbound request routing (agent → Koi)
  // ---------------------------------------------------------------------------

  async function handleInboundRequest(req: RpcInboundRequest): Promise<void> {
    const tr = transport;
    if (tr === undefined) return;

    try {
      switch (req.method) {
        case "fs/read_text_file": {
          const parsed = safeParseFsReadTextFileParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const result = await handleReadTextFile(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "fs/write_text_file": {
          const parsed = safeParseFsWriteTextFileParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const result = await handleWriteTextFile(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "terminal/create": {
          const parsed = safeParseTerminalCreateParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const reg = terminalRegistry;
          if (reg === undefined) {
            tr.send(
              buildErrorResponse(req.id, RPC_ERROR_CODES.INTERNAL_ERROR, "No active session"),
            );
            return;
          }
          const result = await reg.create(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "terminal/output": {
          const parsed = safeParseTerminalSessionParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const reg = terminalRegistry;
          if (reg === undefined) {
            tr.send(
              buildErrorResponse(req.id, RPC_ERROR_CODES.INTERNAL_ERROR, "No active session"),
            );
            return;
          }
          const result = await reg.output(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "terminal/wait_for_exit": {
          const parsed = safeParseTerminalSessionParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const reg = terminalRegistry;
          if (reg === undefined) {
            tr.send(
              buildErrorResponse(req.id, RPC_ERROR_CODES.INTERNAL_ERROR, "No active session"),
            );
            return;
          }
          const result = await reg.waitForExit(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "terminal/kill": {
          const parsed = safeParseTerminalSessionParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const reg = terminalRegistry;
          if (reg === undefined) {
            tr.send(buildResponse(req.id, null));
            return;
          }
          const result = await reg.kill(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "terminal/release": {
          const parsed = safeParseTerminalSessionParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const reg = terminalRegistry;
          if (reg === undefined) {
            tr.send(buildResponse(req.id, null));
            return;
          }
          const result = await reg.release(parsed.data);
          tr.send(buildResponse(req.id, result));
          break;
        }

        case "session/request_permission": {
          const parsed = safeParseSessionRequestPermissionParams(req.params);
          if (!parsed.success) {
            tr.send(
              buildErrorResponse(
                req.id,
                RPC_ERROR_CODES.INVALID_PARAMS,
                `Invalid params: ${parsed.error}`,
              ),
            );
            return;
          }
          const outcome = await resolvePermission(parsed.data, config.approvalHandler);
          tr.send(buildResponse(req.id, { outcome }));
          break;
        }

        default: {
          tr.send(
            buildErrorResponse(
              req.id,
              RPC_ERROR_CODES.METHOD_NOT_FOUND,
              `Method not found: ${req.method}`,
            ),
          );
          break;
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      tr.send(buildErrorResponse(req.id, RPC_ERROR_CODES.INTERNAL_ERROR, message));
    }
  }

  // ---------------------------------------------------------------------------
  // Receive loop — routes all inbound messages
  // ---------------------------------------------------------------------------

  async function runReceiveLoop(): Promise<void> {
    const tr = transport;
    if (tr === undefined) return;

    try {
      for await (const msg of tr.receive()) {
        await routeMessage(msg);
      }
    } catch (error: unknown) {
      console.warn("[engine-acp] Receive loop error:", error);
    } finally {
      // Transport closed — end any active turn
      currentQueue?.end();
      currentQueue = undefined;
      // Reject all pending requests
      for (const [, pending] of pendingRequests) {
        pending.reject({ code: RPC_ERROR_CODES.INTERNAL_ERROR, message: "Transport closed" });
      }
      pendingRequests.clear();
    }
  }

  async function routeMessage(msg: RpcMessage): Promise<void> {
    switch (msg.kind) {
      case "notification": {
        if (msg.method === "session/update") {
          const parsed = parseSessionUpdateParams(msg.params);
          if (parsed === undefined) {
            // Unknown or unrecognised update kind — skip silently.
            // Real agents (codex-acp, openclaw, etc.) emit extension update
            // kinds beyond the ACP spec (e.g., available_commands_update).
            return;
          }
          const events = mapSessionUpdate(parsed.update);
          const queue = currentQueue;
          if (queue !== undefined) {
            for (const event of events) {
              queue.push(event);
            }
          }
        }
        break;
      }

      case "inbound_request": {
        // Agent is requesting a service from Koi — handle asynchronously
        void handleInboundRequest(msg);
        break;
      }

      case "success_response": {
        const key = msg.id;
        const pending = pendingRequests.get(key);
        if (pending !== undefined) {
          pendingRequests.delete(key);
          pending.resolve(msg.result);
        }
        break;
      }

      case "error_response": {
        const key = msg.id;
        const pending = pendingRequests.get(key);
        if (pending !== undefined) {
          pendingRequests.delete(key);
          pending.reject(msg.error);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound request helpers
  // ---------------------------------------------------------------------------

  function sendRequest(method: string, params: unknown): Promise<unknown> {
    const tr = transport;
    if (tr === undefined) {
      return Promise.reject(new Error("Transport not available"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const { id, message } = buildRequest(method, params);
      pendingRequests.set(id, {
        resolve,
        reject: (error) =>
          reject(new Error(`[engine-acp] ${method} failed (${error.code}): ${error.message}`)),
      });
      tr.send(message);
    });
  }

  // ---------------------------------------------------------------------------
  // Spawn + initialize (lazy, called on first stream())
  // ---------------------------------------------------------------------------

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (disposed) throw new Error("AcpAdapter has been disposed");

    // Spawn process
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (config.env !== undefined) {
      for (const [k, v] of Object.entries(config.env)) {
        env[k] = v;
      }
    }
    // Unset CLAUDECODE so the ACP subprocess can start even when Koi itself runs
    // inside a Claude Code session (the nested-session guard checks this var).
    delete env.CLAUDECODE;

    const spawnedProc = Bun.spawn([config.command, ...(config.args ?? [])], {
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    proc = {
      pid: spawnedProc.pid,
      stdin: spawnedProc.stdin,
      stdout: spawnedProc.stdout,
      stderr: spawnedProc.stderr,
      exited: spawnedProc.exited,
      kill: (signal?: number) => spawnedProc.kill(signal),
    };

    transport = createStdioTransport(proc);

    // Start background receive loop
    void runReceiveLoop();

    // Send initialize
    const initResult = await sendRequest("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: config.clientInfo ?? { name: "@koi/engine-acp", version: "0.0.0" },
      clientCapabilities: config.clientCapabilities ?? {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const parsed = parseInitializeResult(initResult);
    if (parsed === undefined) {
      throw new Error("initialize response invalid: unexpected shape");
    }

    negotiatedCapabilities = parsed.agentCapabilities;
    initialized = true;
  }

  // ---------------------------------------------------------------------------
  // stream()
  // ---------------------------------------------------------------------------

  async function* runStream(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error(
        "AcpAdapter does not support concurrent runs. Wait for the current run to complete.",
      );
    }
    if (disposed) {
      const output: EngineOutput = {
        content: [],
        stopReason: "interrupted",
        metrics: createZeroMetrics(0),
      };
      yield { kind: "done", output };
      return;
    }

    running = true;
    const startTime = Date.now();

    try {
      await ensureInitialized();

      // Create session
      terminalRegistry = createTerminalRegistry();
      const sessionResult = await sendRequest("session/new", {
        cwd: config.cwd ?? process.cwd(),
        ...(config.sessionNewParams ?? {}),
      });

      const sessionParsed = parseSessionNewResult(sessionResult);
      if (sessionParsed === undefined) {
        throw new Error("session/new response invalid: unexpected shape");
      }
      currentSessionId = sessionParsed.sessionId;

      const sessionId = currentSessionId;
      const queue = createAsyncQueue<EngineEvent>("session-stream");
      currentQueue = queue;

      // Handle abort signal
      if (input.signal?.aborted === true) {
        const output: EngineOutput = {
          content: [],
          stopReason: "interrupted",
          metrics: createZeroMetrics(Date.now() - startTime),
        };
        yield { kind: "done", output };
        return;
      }

      /** Send SIGINT to the subprocess to interrupt the current operation. */
      const interruptSubprocess = (): void => {
        try {
          proc?.kill(2 /* SIGINT */);
        } catch {
          // Process may have already exited — safe to ignore
        }
      };

      // Abort promise — rejects when the signal fires so we can race against
      // promptPromise and avoid hanging forever if the subprocess ignores SIGINT.
      // let: abort reject function for cleanup
      let rejectAbort: ((reason: Error) => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      // Prevent unhandled rejection if promptPromise wins the race but the
      // abort handler fires concurrently (e.g., signal during finally cleanup).
      abortPromise.catch(() => {});

      const abortHandler = (): void => {
        interruptSubprocess();
        queue.end();
        rejectAbort?.(new Error("ACP prompt aborted"));
      };
      input.signal?.addEventListener("abort", abortHandler, { once: true });

      // Timeout handling
      // let: timeout handle for cleanup
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          interruptSubprocess();
          queue.end();
          rejectAbort?.(new Error("ACP prompt timed out"));
        }, timeoutMs);
      }

      // Build prompt content
      const promptContent = inputToPromptContent(input);

      // Send session/prompt and wait for completion concurrently with queue consumption
      const promptPromise = sendRequest("session/prompt", {
        sessionId,
        prompt: promptContent,
      })
        .then((result) => {
          const parsed = parseSessionPromptResult(result);
          if (parsed === undefined) {
            console.warn("[engine-acp] session/prompt response invalid: unexpected shape");
            return { stopReason: "error" as const, usage: undefined };
          }
          return parsed;
        })
        .catch((error: unknown) => {
          console.warn("[engine-acp] session/prompt error:", error);
          return { stopReason: "error" as const, usage: undefined };
        })
        .finally(() => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          input.signal?.removeEventListener("abort", abortHandler);
          queue.end();
          // Only clear the shared reference if it still points to this run's queue.
          // Prevents a stale .finally() from clobbering a subsequent run's queue.
          if (currentQueue === queue) {
            currentQueue = undefined;
          }
        });

      // Yield events from the queue while prompt is running
      for await (const event of queue) {
        yield event;
      }

      // Await the final stop reason from session/prompt, racing against abort
      // so we don't hang forever when the subprocess ignores SIGINT.
      const promptResult = await Promise.race([promptPromise, abortPromise]).catch(
        (error: unknown) => {
          // Abort/timeout won the race — return an interrupted result
          console.warn("[engine-acp] prompt interrupted:", error);
          return { stopReason: "cancelled" as const, usage: undefined };
        },
      );
      const stopReason = input.signal?.aborted
        ? ("interrupted" as const)
        : mapStopReason(promptResult.stopReason);

      const metrics = createZeroMetrics(Date.now() - startTime);
      const metricsWith: EngineMetrics =
        promptResult.usage !== undefined
          ? {
              ...metrics,
              inputTokens: promptResult.usage.inputTokens ?? 0,
              outputTokens: promptResult.usage.outputTokens ?? 0,
              totalTokens:
                (promptResult.usage.inputTokens ?? 0) + (promptResult.usage.outputTokens ?? 0),
            }
          : metrics;

      // Emit turn_end so L1's onAfterTurn hook fires symmetrically with onBeforeTurn.
      // The entire ACP session maps to a single L1 turn (turnIndex 0).
      yield { kind: "turn_end", turnIndex: 0 };

      const output: EngineOutput = {
        content: [],
        stopReason,
        metrics: metricsWith,
      };
      yield { kind: "done", output };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const output: EngineOutput = {
        content: [{ kind: "text", text: `Error: ${message}` }],
        stopReason: "error",
        metrics: createZeroMetrics(Date.now() - startTime),
        metadata: {
          error: message,
          ...(error instanceof Error && error.cause !== undefined
            ? { cause: String(error.cause) }
            : {}),
        },
      };
      yield { kind: "done", output };
    } finally {
      running = false;
      currentSessionId = undefined;
      terminalRegistry?.releaseAll();
      terminalRegistry = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Adapter interface
  // ---------------------------------------------------------------------------

  return {
    engineId: ENGINE_ID,
    capabilities: ACP_CAPABILITIES,

    get agentCapabilities(): AgentCapabilities | undefined {
      return negotiatedCapabilities;
    },

    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      return runStream(input);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      transport?.close();
      currentQueue?.end();
      currentQueue = undefined;
      if (proc !== undefined) {
        proc.kill();
        proc = undefined;
      }
    },
  };
}
