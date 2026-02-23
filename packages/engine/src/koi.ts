/**
 * createKoi() — the primary factory for assembling and running an agent.
 *
 * Orchestrates: assembly → guard creation → middleware composition → runtime.
 *
 * When `options.forge` is provided, forged capabilities are resolved live:
 * - Tools: resolved at call time (entity first, then forge fallback)
 * - Tool descriptors: entity + forged, refreshed at turn boundaries (deferred)
 * - Middleware: re-composed at turn boundaries (deferred to next iteration,
 *   so consumer can inject between turns)
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
import { createInMemorySpawnLedger } from "./spawn-ledger.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";
import { DEFAULT_SPAWN_POLICY } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(manifest: CreateKoiOptions["manifest"]): ProcessId {
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: "copilot",
    depth: 0,
  };
}

/** Sort middleware by priority (ascending). Guards get low numbers, L2 middleware gets higher. */
function sortByPriority(middleware: readonly KoiMiddleware[]): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
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
  const spawnPolicy = { ...options.spawn };
  const effectiveMaxTotal = spawnPolicy.maxTotalProcesses ?? DEFAULT_SPAWN_POLICY.maxTotalProcesses;
  const spawnLedger = options.spawnLedger ?? createInMemorySpawnLedger(effectiveMaxTotal);
  const guards: readonly KoiMiddleware[] = [
    createIterationGuard(options.limits),
    ...(options.loopDetection !== false
      ? [
          createLoopDetector(
            options.loopDetection === undefined ? undefined : options.loopDetection,
          ),
        ]
      : []),
    createSpawnGuard({
      policy: spawnPolicy,
      agentDepth: pid.depth,
      ledger: spawnLedger,
      agent,
    }),
  ];

  // --- 3. Compose middleware chain: guards + user middleware, sorted by priority ---
  const allMiddleware: readonly KoiMiddleware[] = sortByPriority([...guards, ...middleware]);

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
  // let justified: mutable flag for concurrent run() guard
  let running = false;

  // --- 6. Build runtime ---
  const runtime: KoiRuntime = {
    agent,

    run(input: EngineInput): AsyncIterable<EngineEvent> {
      // Guard concurrent run() calls
      if (running) {
        throw KoiEngineError.from("VALIDATION", "Agent is already running");
      }
      running = true;

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

          // let justified: mutable flag to defer forge refresh until next iteration,
          // giving the consumer a chance to inject tools/middleware between turns
          let pendingForgeRefresh = false;

          // let justified: mutable flag — true when a turn_start event should be emitted
          let shouldEmitTurnStart = true;

          // let justified: mutable middleware chain refs, updated at turn boundaries
          let activeToolChain: (ctx: TurnContext, req: ToolRequest) => Promise<ToolResponse>;
          let activeModelChain: (ctx: TurnContext, req: ModelRequest) => Promise<ModelResponse>;
          let activeStreamChain:
            | ((ctx: TurnContext, req: ModelRequest) => AsyncIterable<ModelChunk>)
            | undefined;

          // let justified: cached terminals created once at session start, reused across turns
          let cachedTerminals:
            | {
                readonly modelHandler: ModelHandler;
                readonly toolHandler: ToolHandler;
                readonly modelStreamHandler?: ModelStreamHandler;
              }
            | undefined;

          // let justified: previous forge middleware ref for identity-based skip
          let previousForgedMw: readonly KoiMiddleware[] | undefined;

          const sessionCtx = {
            agentId: pid.id,
            sessionId: crypto.randomUUID(),
            metadata: {},
          };

          /** Refresh forged descriptors and re-compose middleware if forge runtime is provided. */
          async function refreshForgeState(terminals: {
            readonly modelHandler: ModelHandler;
            readonly toolHandler: ToolHandler;
            readonly modelStreamHandler?: ModelStreamHandler;
          }): Promise<void> {
            if (forge === undefined) return;

            // Refresh forged tool descriptors
            forgedDescriptorsCache = await forge.toolDescriptors();

            // Re-compose middleware chains only when forged middleware actually changed
            if (forge.middleware !== undefined) {
              const forgedMw = await forge.middleware();
              if (forgedMw !== previousForgedMw) {
                previousForgedMw = forgedMw;
                const allMw: readonly KoiMiddleware[] = [...allMiddleware, ...forgedMw];
                activeToolChain = composeToolChain(allMw, terminals.toolHandler);
                activeModelChain = composeModelChain(allMw, terminals.modelHandler);
                if (terminals.modelStreamHandler !== undefined) {
                  activeStreamChain = composeModelStreamChain(allMw, terminals.modelStreamHandler);
                }
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
                  await runSessionHooks(allMiddleware, "onSessionStart", sessionCtx);

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
                      cachedTurnCtx = {
                        ...base,
                        ...(options.approvalHandler !== undefined
                          ? { requestApproval: options.approvalHandler }
                          : {}),
                        ...(options.sendStatus !== undefined
                          ? { sendStatus: options.sendStatus }
                          : {}),
                      };
                      return cachedTurnCtx;
                    };
                    const rawModelTerminal = adapter.terminals.modelCall;
                    const rawToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
                    const rawModelStreamTerminal = adapter.terminals.modelStream;

                    // Create lifecycle-aware terminal handlers (cached for reuse across turns)
                    cachedTerminals = createTerminalHandlers(
                      agent,
                      rawModelTerminal,
                      rawToolTerminal,
                      rawModelStreamTerminal,
                    );

                    // Initial chain composition
                    activeToolChain = composeToolChain(allMiddleware, cachedTerminals.toolHandler);
                    activeModelChain = composeModelChain(
                      allMiddleware,
                      cachedTerminals.modelHandler,
                    );
                    if (cachedTerminals.modelStreamHandler !== undefined) {
                      activeStreamChain = composeModelStreamChain(
                        allMiddleware,
                        cachedTerminals.modelStreamHandler,
                      );
                    }

                    // Initial forge state (descriptors + forged middleware)
                    await refreshForgeState(cachedTerminals);

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

                // Deferred forge refresh: runs AFTER consumer processed turn_end,
                // so tools/middleware injected between turns take effect next turn
                if (pendingForgeRefresh) {
                  pendingForgeRefresh = false;
                  if (forge !== undefined && cachedTerminals !== undefined) {
                    await refreshForgeState(cachedTerminals);
                  }
                }

                // Emit turn_start event with onBeforeTurn hooks
                if (shouldEmitTurnStart) {
                  shouldEmitTurnStart = false;
                  const turnCtx: TurnContext = {
                    session: sessionCtx,
                    turnIndex: currentTurnIndex,
                    messages: input.kind === "messages" ? input.messages : [],
                    metadata: {},
                    ...(options.approvalHandler !== undefined
                      ? { requestApproval: options.approvalHandler }
                      : {}),
                    ...(options.sendStatus !== undefined ? { sendStatus: options.sendStatus } : {}),
                  };
                  await runTurnHooks(allMiddleware, "onBeforeTurn", turnCtx);
                  return {
                    done: false,
                    value: { kind: "turn_start", turnIndex: currentTurnIndex },
                  };
                }

                if (!iterator) {
                  done = true;
                  running = false;
                  return { done: true, value: undefined };
                }

                const result = await iterator.next();

                if (result.done) {
                  done = true;
                  running = false;
                  agent.transition({ kind: "complete", stopReason: "completed" });
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                  return { done: true, value: undefined };
                }

                const event = result.value;

                // Process turn_end events
                if (event.kind === "turn_end") {
                  currentTurnIndex = event.turnIndex + 1;
                  shouldEmitTurnStart = true;
                  const turnCtx: TurnContext = {
                    session: sessionCtx,
                    turnIndex: event.turnIndex,
                    messages: [],
                    metadata: {},
                    ...(options.approvalHandler !== undefined
                      ? { requestApproval: options.approvalHandler }
                      : {}),
                    ...(options.sendStatus !== undefined ? { sendStatus: options.sendStatus } : {}),
                  };

                  // Defer forge refresh to the start of the next next() call,
                  // so the consumer can inject tools/middleware after this turn_end
                  pendingForgeRefresh = true;

                  await runTurnHooks(allMiddleware, "onAfterTurn", turnCtx);
                }

                // Process done events
                if (event.kind === "done") {
                  done = true;
                  pendingForgeRefresh = false;
                  running = false;
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
                running = false;

                // If it's a guard error, convert to a done event
                if (error instanceof KoiEngineError) {
                  const stopReason = error.code === "TIMEOUT" ? "max_turns" : "error";
                  agent.transition({ kind: "complete", stopReason });
                  try {
                    await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                  } catch {
                    // Don't mask guard error → done event conversion
                  }
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
                try {
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                } catch {
                  // Don't mask original error — onSessionEnd failure must not override thrown error
                }
                throw error;
              }
            },

            async return(): Promise<IteratorResult<EngineEvent>> {
              done = true;
              running = false;
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
