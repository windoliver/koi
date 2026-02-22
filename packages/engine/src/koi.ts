/**
 * createKoi() — the primary factory for assembling and running an agent.
 *
 * Orchestrates: assembly → guard creation → middleware composition → runtime.
 *
 * When `options.forge` is provided, forged capabilities are resolved live:
 * - Tools: resolved at call time (entity first, then forge fallback)
 * - Tool descriptors: entity + forged, refreshed at turn boundaries
 * - Middleware: re-composed at turn boundaries when forged middleware changes
 */

import type {
  ComposedCallHandlers,
  EngineEvent,
  EngineInput,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ProcessId,
  Tool,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { AgentEntity } from "./agent-entity.js";
import {
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  createTerminalHandlers,
  runSessionHooks,
  runTurnHooks,
} from "./compose.js";
import { KoiEngineError } from "./errors.js";
import { createIterationGuard, createLoopDetector, createSpawnGuard } from "./guards.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(manifest: CreateKoiOptions["manifest"]): ProcessId {
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: "copilot",
    depth: 0,
  };
}

export async function createKoi(options: CreateKoiOptions): Promise<KoiRuntime> {
  // --- 0. Input validation at the factory boundary ---
  if (!options.manifest?.name) {
    throw KoiEngineError.from("VALIDATION", "manifest.name is required", {
      context: { manifest: options.manifest },
    });
  }
  if (typeof options.adapter?.stream !== "function") {
    throw KoiEngineError.from("VALIDATION", "adapter must implement stream()", {
      context: { adapterId: options.adapter?.engineId },
    });
  }

  const { manifest, adapter, middleware = [], providers = [], forge } = options;

  // --- 1. Assemble the agent entity ---
  const pid = generatePid(manifest);
  const agent = await AgentEntity.assemble(pid, manifest, providers);

  // --- 2. Create L1 guards (declarative, no mutation) ---
  const guards: readonly KoiMiddleware[] = [
    createIterationGuard(options.limits),
    ...(options.loopDetection !== false
      ? [
          createLoopDetector(
            options.loopDetection === undefined ? undefined : options.loopDetection,
          ),
        ]
      : []),
    createSpawnGuard(options.spawn, pid.depth),
  ];

  // --- 3. Base middleware: guards first, then user middleware ---
  const baseMiddleware: readonly KoiMiddleware[] = [...guards, ...middleware];

  // --- 4. Default tool terminal (entity first, then forge fallback) ---
  const defaultToolTerminal = async (request: ToolRequest): Promise<ToolResponse> => {
    // O(1) entity lookup (manifest-defined + previously assembled forged tools)
    const tool: Tool | undefined =
      agent.component(toolToken(request.toolId)) ?? (await forge?.resolveTool(request.toolId));

    if (tool === undefined) {
      throw KoiEngineError.from("NOT_FOUND", `Tool not found: "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    }
    const output = await tool.execute(request.input);
    return request.metadata !== undefined ? { output, metadata: request.metadata } : { output };
  };

  // --- 5. Track disposal ---
  // let justified: mutable flag for one-shot dispose guard
  let disposed = false;

  // --- 6. Build runtime ---
  const runtime: KoiRuntime = {
    agent,

    run: (input: EngineInput): AsyncIterable<EngineEvent> => {
      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          // let justified: mutable iterator state scoped to this run() invocation
          let iterator: AsyncIterator<EngineEvent> | undefined;
          let sessionStarted = false;
          let done = false;
          let currentTurnIndex = 0;
          const sessionStartedAt = Date.now();

          // let justified: mutable forged descriptor cache, refreshed at turn boundaries
          let forgedDescriptorsCache: readonly ToolDescriptor[] = [];

          // let justified: mutable middleware chain refs, updated at turn boundaries
          let activeToolChain: (ctx: TurnContext, req: ToolRequest) => Promise<ToolResponse>;
          let activeModelChain: (ctx: TurnContext, req: ModelRequest) => Promise<ModelResponse>;
          let activeStreamChain:
            | ((ctx: TurnContext, req: ModelRequest) => AsyncIterable<ModelChunk>)
            | undefined;

          const sessionCtx = {
            agentId: pid.id,
            sessionId: crypto.randomUUID(),
            metadata: {},
          };

          /** Refresh forged descriptors and re-compose middleware if forge runtime is provided. */
          async function refreshForgeState(
            _getTurnContext: () => TurnContext,
            terminals: {
              readonly modelHandler: ModelHandler;
              readonly toolHandler: ToolHandler;
              readonly modelStreamHandler?: ModelStreamHandler;
            },
          ): Promise<void> {
            if (forge === undefined) return;

            // Refresh forged tool descriptors
            forgedDescriptorsCache = await forge.toolDescriptors();

            // Re-compose middleware chains if forged middleware provider exists
            if (forge.middleware !== undefined) {
              const forgedMw = await forge.middleware();
              const allMw: readonly KoiMiddleware[] = [...baseMiddleware, ...forgedMw];
              activeToolChain = composeToolChain(allMw, terminals.toolHandler);
              activeModelChain = composeModelChain(allMw, terminals.modelHandler);
              if (terminals.modelStreamHandler !== undefined) {
                activeStreamChain = composeModelStreamChain(allMw, terminals.modelStreamHandler);
              }
            }
          }

          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (done) return { done: true, value: undefined };

              try {
                // Start session on first call
                if (!sessionStarted) {
                  sessionStarted = true;
                  agent.transition({ kind: "start" });
                  await runSessionHooks(baseMiddleware, "onSessionStart", sessionCtx);

                  // Wire terminals → middleware → callHandlers if adapter is cooperating
                  // let justified: effectiveInput may be replaced with callHandlers-augmented input
                  let effectiveInput = input;
                  if (adapter.terminals) {
                    const inputMessages = input.kind === "messages" ? input.messages : [];
                    // Cache turn context per turn index to avoid repeated allocations
                    // let justified: mutable cache invalidated on turn index change
                    let cachedTurnCtx: TurnContext | undefined;
                    let cachedTurnIndex = -1;
                    const getTurnContext = (): TurnContext => {
                      if (cachedTurnIndex === currentTurnIndex && cachedTurnCtx) {
                        return cachedTurnCtx;
                      }
                      cachedTurnIndex = currentTurnIndex;
                      const base = {
                        session: sessionCtx,
                        turnIndex: currentTurnIndex,
                        messages: inputMessages,
                        metadata: {},
                      };
                      cachedTurnCtx =
                        options.approvalHandler !== undefined
                          ? { ...base, requestApproval: options.approvalHandler }
                          : base;
                      return cachedTurnCtx;
                    };
                    const rawModelTerminal = adapter.terminals.modelCall;
                    const rawToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
                    const rawModelStreamTerminal = adapter.terminals.modelStream;

                    // Create lifecycle-aware terminal handlers
                    const terminals = createTerminalHandlers(
                      agent,
                      rawModelTerminal,
                      rawToolTerminal,
                      rawModelStreamTerminal,
                    );

                    // Initial chain composition
                    activeToolChain = composeToolChain(baseMiddleware, terminals.toolHandler);
                    activeModelChain = composeModelChain(baseMiddleware, terminals.modelHandler);
                    if (terminals.modelStreamHandler !== undefined) {
                      activeStreamChain = composeModelStreamChain(
                        baseMiddleware,
                        terminals.modelStreamHandler,
                      );
                    }

                    // Initial forge state (descriptors + forged middleware)
                    await refreshForgeState(getTurnContext, terminals);

                    // Extract entity tool descriptors (static, from assembly)
                    const entityTools = agent.query<Tool>("tool:");
                    const entityDescriptors: readonly ToolDescriptor[] = [
                      ...entityTools.values(),
                    ].map((t) => t.descriptor);

                    // Build callHandlers with dynamic tools getter and chain refs
                    // Capture stream chain presence — the mutable ref is read inside the closure
                    const hasStreamChain = activeStreamChain !== undefined;
                    const streamChainProxy = (request: ModelRequest) =>
                      activeStreamChain?.(getTurnContext(), request);

                    const callHandlers: ComposedCallHandlers = Object.defineProperties(
                      {
                        modelCall: (request: ModelRequest) =>
                          activeModelChain(getTurnContext(), request),
                        toolCall: (request: ToolRequest) =>
                          activeToolChain(getTurnContext(), request),
                        tools: entityDescriptors, // placeholder, overridden by getter below
                        ...(hasStreamChain ? { modelStream: streamChainProxy } : {}),
                      },
                      {
                        tools: {
                          get(): readonly ToolDescriptor[] {
                            if (forgedDescriptorsCache.length === 0) {
                              return entityDescriptors;
                            }
                            return [...entityDescriptors, ...forgedDescriptorsCache];
                          },
                          enumerable: true,
                          configurable: false,
                        },
                      },
                    ) as ComposedCallHandlers;

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
                  await runSessionHooks(baseMiddleware, "onSessionEnd", sessionCtx);
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

                  // Refresh forged state at turn boundary (new tools + middleware)
                  if (forge !== undefined && adapter.terminals) {
                    const rawModelTerminal = adapter.terminals.modelCall;
                    const rawToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
                    const rawModelStreamTerminal = adapter.terminals.modelStream;
                    const terminals = createTerminalHandlers(
                      agent,
                      rawModelTerminal,
                      rawToolTerminal,
                      rawModelStreamTerminal,
                    );
                    await refreshForgeState(() => turnCtx, terminals);
                  }

                  await runTurnHooks(baseMiddleware, "onAfterTurn", turnCtx);
                }

                // Process done events
                if (event.kind === "done") {
                  done = true;
                  agent.transition({
                    kind: "complete",
                    stopReason: event.output.stopReason,
                    metrics: event.output.metrics,
                  });
                  await runSessionHooks(baseMiddleware, "onSessionEnd", sessionCtx);
                }

                return { done: false, value: event };
              } catch (error: unknown) {
                done = true;

                // If it's a guard error, convert to a done event
                if (error instanceof KoiEngineError) {
                  const stopReason = error.code === "TIMEOUT" ? "max_turns" : "error";
                  agent.transition({ kind: "complete", stopReason });
                  await runSessionHooks(baseMiddleware, "onSessionEnd", sessionCtx);
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
                await runSessionHooks(baseMiddleware, "onSessionEnd", sessionCtx);
                throw error;
              }
            },

            async return(): Promise<IteratorResult<EngineEvent>> {
              done = true;
              if (iterator?.return) {
                await iterator.return();
              }
              agent.transition({ kind: "complete", stopReason: "interrupted" });
              await runSessionHooks(baseMiddleware, "onSessionEnd", sessionCtx);
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
