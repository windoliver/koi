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
  ApprovalHandler,
  ChannelStatus,
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
  RunId,
  SessionContext,
  SessionId,
  Tool,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, runId, sessionId, toolToken, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { runWithExecutionContext } from "@koi/execution-context";
import { AgentEntity } from "./agent-entity.js";
import {
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  createTerminalHandlers,
  injectCapabilities,
  runSessionHooks,
  runTurnHooks,
} from "./compose.js";
import { composeExtensions, createDefaultGuardExtension } from "./extension-composer.js";
import { createGovernanceExtension } from "./governance-extension.js";
import { createGovernanceProvider } from "./governance-provider.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(
  manifest: { readonly name: string },
  options?: {
    readonly parent?: ProcessId;
    readonly agentType?: "copilot" | "worker";
  },
): ProcessId {
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: options?.agentType ?? (options?.parent !== undefined ? "worker" : "copilot"),
    depth: options?.parent !== undefined ? options.parent.depth + 1 : 0,
    ...(options?.parent !== undefined ? { parent: options.parent.id } : {}),
  };
}

/** Sort middleware by priority (ascending). Guards get low numbers, L2 middleware gets higher. */
function sortByPriority(middleware: readonly KoiMiddleware[]): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

/** Factory for constructing TurnContext with hierarchical turnId. */
function createTurnContext(opts: {
  readonly session: SessionContext;
  readonly turnIndex: number;
  readonly messages: readonly import("@koi/core").InboundMessage[];
  readonly signal?: AbortSignal | undefined;
  readonly approvalHandler?: ApprovalHandler | undefined;
  readonly sendStatus?: ((status: ChannelStatus) => Promise<void>) | undefined;
}): TurnContext {
  return {
    session: opts.session,
    turnIndex: opts.turnIndex,
    turnId: turnId(opts.session.runId, opts.turnIndex),
    messages: opts.messages,
    metadata: {},
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.approvalHandler !== undefined ? { requestApproval: opts.approvalHandler } : {}),
    ...(opts.sendStatus !== undefined ? { sendStatus: opts.sendStatus } : {}),
  };
}

export async function createKoi(options: CreateKoiOptions): Promise<KoiRuntime> {
  // --- 0. Input validation at the factory boundary ---
  if (!options.manifest?.name) {
    throw KoiRuntimeError.from("VALIDATION", "manifest.name is required", {
      context: { manifest: options.manifest },
    });
  }
  if (typeof options.adapter?.stream !== "function") {
    throw KoiRuntimeError.from("VALIDATION", "adapter must implement stream()", {
      context: { adapterId: options.adapter?.engineId },
    });
  }

  const { manifest, adapter, middleware = [], providers = [], forge } = options;

  // --- 1. Assemble the agent entity (with governance provider) ---
  const pid = generatePid(manifest, {
    ...(options.parentPid !== undefined ? { parent: options.parentPid } : {}),
    ...(options.agentType !== undefined ? { agentType: options.agentType } : {}),
  });
  const governanceProvider = createGovernanceProvider(options.governance);
  const allProviders = [governanceProvider, ...providers];
  const { agent, conflicts } = await AgentEntity.assemble(pid, manifest, allProviders);

  // --- 2. Compose kernel extensions (governance + default guards) ---
  const governanceExt = createGovernanceExtension();
  const defaultGuardExt = createDefaultGuardExtension({
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.loopDetection !== undefined ? { loopDetection: options.loopDetection } : {}),
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  });
  const allExtensions = [governanceExt, defaultGuardExt, ...(options.extensions ?? [])];

  const guardCtx = {
    agentDepth: pid.depth,
    manifest,
    components: agent.components(),
    agent,
  };
  const composed = await composeExtensions(allExtensions, guardCtx);

  // --- 2b. Run assembly validators ---
  const assemblyResult = await composed.validateAssembly(agent.components(), manifest);
  if (!assemblyResult.ok) {
    const messages = assemblyResult.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.source}] ${d.message}`);
    throw KoiRuntimeError.from("VALIDATION", `Assembly validation failed: ${messages.join("; ")}`, {
      context: { diagnostics: assemblyResult.diagnostics },
    });
  }

  // --- 2c. Wire transition validator into agent entity ---
  agent.setTransitionValidator(composed.validateTransition);

  // --- 3. Compose middleware chain: guard middleware + user middleware, sorted by priority ---
  const allMiddleware: readonly KoiMiddleware[] = sortByPriority([
    ...composed.guardMiddleware,
    ...middleware,
  ]);

  // --- 4. Default tool terminal (forge first, then entity fallback) ---
  const defaultToolTerminal = async (request: ToolRequest): Promise<ToolResponse> => {
    // Forge-first: forged tools shadow entity tools (Agent-forged > Bundled)
    const tool: Tool | undefined =
      (await forge?.resolveTool(request.toolId)) ?? agent.component(toolToken(request.toolId));

    if (tool === undefined) {
      throw KoiRuntimeError.from("NOT_FOUND", `Tool not found: "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    }
    const output = await tool.execute(
      request.input,
      request.signal !== undefined ? { signal: request.signal } : undefined,
    );
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
    conflicts,

    run(input: EngineInput): AsyncIterable<EngineEvent> {
      // Guard concurrent run() calls
      if (running) {
        throw KoiRuntimeError.from("VALIDATION", "Agent is already running");
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

          // AbortSignal: compose caller signal with internal controller
          const abortController = new AbortController();
          const runSignal =
            input.signal !== undefined
              ? AbortSignal.any([input.signal, abortController.signal])
              : abortController.signal;

          // Abort listener: mark done when signal fires.
          // Discriminates reason via signal.reason (typed AbortReason).
          const onAbort = (): void => {
            if (!done) {
              done = true;
              running = false;
              cleanupForgeSubscription();
              agent.transition({ kind: "complete", stopReason: "interrupted" });
            }
          };
          runSignal.addEventListener("abort", onAbort, { once: true });

          // let justified: mutable forged descriptor cache, refreshed at turn boundaries
          let forgedDescriptorsCache: readonly ToolDescriptor[] = [];
          // let justified: mutable memo for deduped tools getter — avoids O(n) alloc per access
          let dedupedToolsMemo: readonly ToolDescriptor[] = [];
          let dedupedForgeRef: readonly ToolDescriptor[] = forgedDescriptorsCache;

          // let justified: mutable flag to defer forge refresh until next iteration,
          // giving the consumer a chance to inject tools/middleware between turns
          let pendingForgeRefresh = false;

          // let justified: dirty flag — true when onChange fired since last turn-boundary refresh
          let forgeStateDirty = false;

          // let justified: mutable ref for forge onChange unsubscribe
          let unsubForgeChange: (() => void) | undefined;

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

          // Structured IDs encode trust boundary: agent ownership is parseable from the ID itself.
          // Format: "agent:{agentId}:{uuid}" for session, plain UUID for run.
          const sid: SessionId = sessionId(`agent:${pid.id}:${crypto.randomUUID()}`);
          const rid: RunId = runId(crypto.randomUUID());
          const sessionCtx: SessionContext = {
            agentId: pid.id,
            sessionId: sid,
            runId: rid,
            ...(options.userId !== undefined ? { userId: options.userId } : {}),
            ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
            metadata: {},
          };

          /** Unsubscribe from forge onChange and clear the ref. */
          function cleanupForgeSubscription(): void {
            if (unsubForgeChange !== undefined) {
              unsubForgeChange();
              unsubForgeChange = undefined;
            }
          }

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
                  let effectiveInput: EngineInput = { ...input, signal: runSignal };
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
                      cachedTurnCtx = createTurnContext({
                        session: sessionCtx,
                        turnIndex: currentTurnIndex,
                        messages: inputMessages,
                        signal: runSignal,
                        approvalHandler: options.approvalHandler,
                        sendStatus: options.sendStatus,
                      });
                      return cachedTurnCtx;
                    };
                    const rawModelTerminal = adapter.terminals.modelCall;
                    const baseToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
                    // Wrap tool terminal with execution context so tools can
                    // read session identity via getExecutionContext().
                    const rawToolTerminal: ToolHandler = (request) => {
                      const execCtx = { session: sessionCtx, turnIndex: currentTurnIndex };
                      return runWithExecutionContext(execCtx, () => baseToolTerminal(request));
                    };
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

                    // Subscribe to forge push notifications for mid-session tool visibility
                    if (forge?.watch !== undefined) {
                      unsubForgeChange = forge.watch((_event) => {
                        // Eagerly refresh descriptor cache (fire-and-forget)
                        void forge
                          .toolDescriptors()
                          .then((d) => {
                            forgedDescriptorsCache = d;
                          })
                          .catch((_err: unknown) => {
                            // Stale cache is graceful degradation — descriptor
                            // refresh failure is non-fatal; next turn boundary
                            // will retry via refreshForgeState.
                          });
                        // Set dirty flag for turn-boundary middleware recomposition
                        forgeStateDirty = true;
                      });
                    }

                    // Extract entity tool descriptors (static, from assembly)
                    const entityTools = agent.query<Tool>("tool:");
                    const entityDescriptors: readonly ToolDescriptor[] = [
                      ...entityTools.values(),
                    ].map((t) => t.descriptor);

                    // Build callHandlers with dynamic tools getter and chain refs
                    // Capture stream chain presence — the mutable ref is read inside the closure
                    const hasStreamChain = activeStreamChain !== undefined;

                    // Pre-compute capability injection flag at composition time (fast-path)
                    const hasCapabilities = allMiddleware.some(
                      (mw) => mw.describeCapabilities !== undefined,
                    );

                    // Inject tool descriptors + capability descriptions into ModelRequest
                    const prepareRequest = (request: ModelRequest): ModelRequest => {
                      // Inject tool descriptors if not already present
                      const withTools: ModelRequest =
                        request.tools !== undefined
                          ? request
                          : { ...request, tools: callHandlers.tools };
                      if (!hasCapabilities) return withTools;
                      return injectCapabilities(allMiddleware, getTurnContext(), withTools);
                    };

                    const streamChainProxy = (request: ModelRequest) =>
                      activeStreamChain?.(getTurnContext(), prepareRequest(request));

                    const callHandlers: ComposedCallHandlers = Object.defineProperties(
                      {
                        modelCall: (request: ModelRequest) =>
                          activeModelChain(getTurnContext(), prepareRequest(request)),
                        toolCall: (request: ToolRequest) => {
                          const ctx = getTurnContext();
                          const effectiveRequest =
                            ctx.signal !== undefined ? { ...request, signal: ctx.signal } : request;
                          return activeToolChain(ctx, effectiveRequest);
                        },
                        tools: entityDescriptors, // placeholder, overridden by getter below
                        ...(hasStreamChain ? { modelStream: streamChainProxy } : {}),
                      },
                      {
                        tools: {
                          get(): readonly ToolDescriptor[] {
                            if (forgedDescriptorsCache.length === 0) {
                              return entityDescriptors;
                            }
                            // Memoized: recompute only when forgedDescriptorsCache ref changes
                            if (dedupedForgeRef !== forgedDescriptorsCache) {
                              dedupedForgeRef = forgedDescriptorsCache;
                              const forgedNames = new Set(
                                forgedDescriptorsCache.map((d) => d.name),
                              );
                              dedupedToolsMemo = [
                                ...forgedDescriptorsCache,
                                ...entityDescriptors.filter((d) => !forgedNames.has(d.name)),
                              ];
                            }
                            return dedupedToolsMemo;
                          },
                          enumerable: true,
                          configurable: false,
                        },
                      },
                    ) as ComposedCallHandlers;

                    effectiveInput = { ...input, callHandlers, signal: runSignal };
                  }

                  iterator = adapter.stream(effectiveInput)[Symbol.asyncIterator]();
                }

                // Deferred forge refresh: runs AFTER consumer processed turn_end,
                // so tools/middleware injected between turns take effect next turn
                if (pendingForgeRefresh) {
                  pendingForgeRefresh = false;
                  // Skip refresh if watch is active and nothing changed since last notification
                  const shouldRefresh = forge?.watch === undefined || forgeStateDirty;
                  if (shouldRefresh && forge !== undefined && cachedTerminals !== undefined) {
                    forgeStateDirty = false;
                    await refreshForgeState(cachedTerminals);
                  }
                }

                // Emit turn_start event with onBeforeTurn hooks
                if (shouldEmitTurnStart) {
                  shouldEmitTurnStart = false;
                  const turnCtx = createTurnContext({
                    session: sessionCtx,
                    turnIndex: currentTurnIndex,
                    messages: input.kind === "messages" ? input.messages : [],
                    signal: runSignal,
                    approvalHandler: options.approvalHandler,
                    sendStatus: options.sendStatus,
                  });
                  await runTurnHooks(allMiddleware, "onBeforeTurn", turnCtx);
                  return {
                    done: false,
                    value: { kind: "turn_start", turnIndex: currentTurnIndex },
                  };
                }

                if (!iterator) {
                  done = true;
                  running = false;
                  cleanupForgeSubscription();
                  return { done: true, value: undefined };
                }

                const result = await iterator.next();

                if (result.done) {
                  done = true;
                  running = false;
                  cleanupForgeSubscription();
                  runSignal.removeEventListener("abort", onAbort);
                  agent.transition({ kind: "complete", stopReason: "completed" });
                  await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
                  return { done: true, value: undefined };
                }

                const event = result.value;

                // Process turn_end events
                if (event.kind === "turn_end") {
                  currentTurnIndex = event.turnIndex + 1;
                  shouldEmitTurnStart = true;
                  const turnCtx = createTurnContext({
                    session: sessionCtx,
                    turnIndex: event.turnIndex,
                    messages: [],
                    signal: runSignal,
                    approvalHandler: options.approvalHandler,
                    sendStatus: options.sendStatus,
                  });

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
                  cleanupForgeSubscription();
                  runSignal.removeEventListener("abort", onAbort);
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
                cleanupForgeSubscription();
                runSignal.removeEventListener("abort", onAbort);

                // If it's a guard error, convert to a done event
                if (error instanceof KoiRuntimeError) {
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
              cleanupForgeSubscription();
              runSignal.removeEventListener("abort", onAbort);
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
