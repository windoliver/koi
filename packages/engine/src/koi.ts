/**
 * createKoi() — the primary factory for assembling and running an agent.
 *
 * Orchestrates: assembly → guard creation → middleware composition → runtime.
 */

import type { EngineEvent, EngineInput, KoiMiddleware, ToolRequest, ToolResponse } from "@koi/core";
import { toolToken } from "@koi/core";
import { AgentEntity } from "./agent-entity.js";
import { createComposedCallHandlers, runSessionHooks, runTurnHooks } from "./compose.js";
import { KoiEngineError } from "./errors.js";
import { createIterationGuard, createLoopDetector, createSpawnGuard } from "./guards.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(manifest: CreateKoiOptions["manifest"]): {
  readonly id: string;
  readonly name: string;
  readonly type: "copilot" | "worker";
  readonly depth: number;
} {
  return {
    id: crypto.randomUUID(),
    name: manifest.name,
    type: "copilot",
    depth: 0,
  };
}

export async function createKoi(options: CreateKoiOptions): Promise<KoiRuntime> {
  const { manifest, adapter, middleware = [], providers = [] } = options;

  // --- 1. Assemble the agent entity ---
  const pid = generatePid(manifest);
  const agent = await AgentEntity.assemble(pid, manifest, providers);

  // --- 2. Create L1 guards ---
  const guards: KoiMiddleware[] = [createIterationGuard(options.limits)];

  if (options.loopDetection !== false) {
    guards.push(
      createLoopDetector(options.loopDetection === undefined ? undefined : options.loopDetection),
    );
  }

  guards.push(createSpawnGuard(options.spawn, pid.depth));

  // --- 3. Compose middleware chain: guards first, then user middleware ---
  const allMiddleware: readonly KoiMiddleware[] = [...guards, ...middleware];

  // --- 4. Default tool terminal (looks up tools from agent components via O(1) token) ---
  const defaultToolTerminal = async (request: ToolRequest): Promise<ToolResponse> => {
    const tool = agent.component(toolToken(request.toolId));
    if (tool === undefined) {
      throw KoiEngineError.from("NOT_FOUND", `Tool not found: "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    }
    const output = await tool.execute(request.input);
    return request.metadata !== undefined ? { output, metadata: request.metadata } : { output };
  };

  // --- 5. Track disposal ---
  let disposed = false;

  // --- 6. Build runtime ---
  const runtime: KoiRuntime = {
    agent,

    run: (input: EngineInput): AsyncIterable<EngineEvent> => {
      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          let iterator: AsyncIterator<EngineEvent> | undefined;
          let sessionStarted = false;
          let done = false;
          let currentTurnIndex = 0; // let justified: updated on turn_end events
          const sessionStartedAt = Date.now();

          const sessionCtx = {
            agentId: pid.id,
            sessionId: crypto.randomUUID(),
            metadata: {},
          };

          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (done) return { done: true, value: undefined };

              try {
                // Start session on first call
                if (!sessionStarted) {
                  sessionStarted = true;
                  agent.transition({ kind: "start" });
                  await runSessionHooks(allMiddleware, "onSessionStart", sessionCtx);

                  // Wire terminals → middleware → callHandlers if adapter is cooperating
                  let effectiveInput = input;
                  if (adapter.terminals) {
                    const inputMessages = input.kind === "messages" ? input.messages : [];
                    const getTurnContext = () => {
                      const base = {
                        session: sessionCtx,
                        turnIndex: currentTurnIndex,
                        messages: inputMessages,
                        metadata: {},
                      };
                      return options.approvalHandler !== undefined
                        ? { ...base, requestApproval: options.approvalHandler }
                        : base;
                    };
                    const rawModelTerminal = adapter.terminals.modelCall;
                    const rawToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
                    const rawModelStreamTerminal = adapter.terminals.modelStream;
                    const callHandlers = createComposedCallHandlers(
                      allMiddleware,
                      getTurnContext,
                      agent,
                      rawModelTerminal,
                      rawToolTerminal,
                      rawModelStreamTerminal,
                    );
                    effectiveInput = { ...input, callHandlers };
                  }

                  iterator = adapter.stream(effectiveInput)[Symbol.asyncIterator]();
                }

                if (!iterator) {
                  done = true;
                  return { done: true, value: undefined };
                }

                const result = await iterator.next();

                if (result.done) {
                  done = true;
                  agent.transition({ kind: "complete", stopReason: "completed" });
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                  return { done: true, value: undefined };
                }

                const event = result.value;

                // Process turn_end events
                if (event.kind === "turn_end") {
                  currentTurnIndex = event.turnIndex + 1;
                  const turnCtx = {
                    session: sessionCtx,
                    turnIndex: event.turnIndex,
                    messages: [],
                    metadata: {},
                    ...(options.approvalHandler !== undefined
                      ? { requestApproval: options.approvalHandler }
                      : {}),
                  };
                  await runTurnHooks(allMiddleware, "onAfterTurn", turnCtx);
                }

                // Process done events
                if (event.kind === "done") {
                  done = true;
                  agent.transition({
                    kind: "complete",
                    stopReason: event.output.stopReason,
                    metrics: event.output.metrics,
                  });
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                }

                return { done: false, value: event };
              } catch (error: unknown) {
                done = true;

                // If it's a guard error, convert to a done event
                if (error instanceof KoiEngineError) {
                  const stopReason = error.code === "TIMEOUT" ? "max_turns" : "error";
                  agent.transition({ kind: "complete", stopReason });
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                  const doneEvent: EngineEvent = {
                    kind: "done",
                    output: {
                      content: [],
                      stopReason,
                      metrics: {
                        totalTokens: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        turns: 0,
                        durationMs: Date.now() - sessionStartedAt,
                      },
                    },
                  };
                  return { done: false, value: doneEvent };
                }

                // Re-throw unexpected errors
                agent.transition({ kind: "error", error });
                await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                throw error;
              }
            },

            async return(): Promise<IteratorResult<EngineEvent>> {
              done = true;
              if (iterator?.return) {
                await iterator.return();
              }
              agent.transition({ kind: "complete", stopReason: "interrupted" });
              await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await adapter.dispose?.();
    },
  };

  return runtime;
}
