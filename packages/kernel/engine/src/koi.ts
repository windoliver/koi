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
  AgentGroupId,
  ApprovalHandler,
  ChannelStatus,
  ComposedCallHandlers,
  EngineEvent,
  EngineInput,
  InboxComponent,
  InboxItem,
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
import { agentId, INBOX, runId, sessionId, toolToken, turnId } from "@koi/core";
import {
  composeExtensions,
  createDefaultGuardExtension,
  injectCapabilities,
  recomposeChains,
  resolveActiveMiddleware,
  runSessionHooks,
  runTurnHooks,
} from "@koi/engine-compose";
import { createGovernanceExtension, createGovernanceProvider } from "@koi/engine-reconcile";
import { KoiRuntimeError } from "@koi/errors";
import { runWithExecutionContext } from "@koi/execution-context";
import { AgentEntity } from "./agent-entity.js";
import { createBrickRequiresExtension } from "./brick-requires-extension.js";
import { createTerminalHandlers } from "./compose-bridge.js";
import { createDedupedToolsAccessor } from "./deduped-tools-accessor.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(
  manifest: { readonly name: string; readonly lifecycle?: "copilot" | "worker" | undefined },
  options?: {
    readonly parent?: ProcessId;
    readonly groupId?: AgentGroupId;
  },
): ProcessId {
  // Manifest lifecycle is the primary source of truth.
  // Fallback: worker if spawned (has parent), copilot if top-level.
  const agentType = manifest.lifecycle ?? (options?.parent !== undefined ? "worker" : "copilot");
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: agentType,
    depth: options?.parent !== undefined ? options.parent.depth + 1 : 0,
    ...(options?.parent !== undefined ? { parent: options.parent.id } : {}),
    ...(options?.groupId !== undefined ? { groupId: options.groupId } : {}),
  };
}

/** Call .unref() on a timer if available (Bun Timer). Prevents idle timer from keeping process alive. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (timer !== null && typeof timer === "object" && "unref" in timer) {
    (timer as { readonly unref: () => void }).unref();
  }
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
    ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
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
  const brickRequiresExt = createBrickRequiresExtension();
  const allExtensions = [
    governanceExt,
    defaultGuardExt,
    brickRequiresExt,
    ...(options.extensions ?? []),
  ];

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

  // --- 3. Compose middleware chain: guard middleware + user middleware, phase-sorted ---
  const allMiddleware: readonly KoiMiddleware[] = resolveActiveMiddleware([
    ...composed.guardMiddleware,
    ...middleware,
  ]);

  // Runtime warning for JS consumers that omit describeCapabilities (TS catches at compile time)
  for (const mw of allMiddleware) {
    if (mw.describeCapabilities === undefined) {
      console.warn(
        `[koi] Middleware "${mw.name}" does not implement describeCapabilities(). ` +
          `This will be a hard error in a future release.`,
      );
    }
  }

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

  // --- 6. Async generator: produces EngineEvents for a single run() invocation ---
  async function* streamEvents(input: EngineInput): AsyncGenerator<EngineEvent> {
    const sessionStartedAt = Date.now();
    // let justified: mutable turn counter incremented on turn_end
    let currentTurnIndex = 0;
    let sessionStarted = false;

    // AbortSignal: compose caller signal with internal controller
    const abortController = new AbortController();
    const runSignal =
      input.signal !== undefined
        ? AbortSignal.any([input.signal, abortController.signal])
        : abortController.signal;

    // Abort listener: immediate agent transition for external observers.
    // The generator's finally block handles resource cleanup.
    const onAbort = (): void => {
      if (agent.state === "running") {
        agent.transition({ kind: "complete", stopReason: "interrupted" });
      }
    };
    runSignal.addEventListener("abort", onAbort, { once: true });

    // let justified: mutable forged descriptor cache, refreshed at turn boundaries
    let forgedDescriptorsCache: readonly ToolDescriptor[] = [];
    // let justified: mutable flag to defer forge refresh until next turn
    let pendingForgeRefresh = false;
    // let justified: dirty flag — true when onChange fired since last turn-boundary refresh
    let forgeStateDirty = false;
    // let justified: mutable ref for forge onChange unsubscribe
    let unsubForgeChange: (() => void) | undefined;

    // let justified: mutable middleware chain refs, updated at turn boundaries
    let activeToolChain: (ctx: TurnContext, req: ToolRequest) => Promise<ToolResponse>;
    let activeModelChain: (ctx: TurnContext, req: ModelRequest) => Promise<ModelResponse>;
    let activeStreamChain:
      | ((ctx: TurnContext, req: ModelRequest) => AsyncIterable<ModelChunk>)
      | undefined;

    // let justified: mutable ref for identity-based dynamic middleware skip
    let previousDynamicMw: readonly KoiMiddleware[] | undefined;

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

    // let justified: tools accessor for cooperating adapters (set once at session start)
    let toolsAccessor: ReturnType<typeof createDedupedToolsAccessor> | undefined;

    // let justified: pending engine events emitted by terminal wrappers (e.g., discovery:miss)
    const pendingEngineEvents: EngineEvent[] = [];

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
      toolsAccessor?.updateForged(forgedDescriptorsCache);

      // Re-compose middleware chains only when forged middleware actually changed
      if (forge.middleware !== undefined) {
        const forgedMw = await forge.middleware();
        if (forgedMw !== previousForgedMw) {
          previousForgedMw = forgedMw;
          const sorted = resolveActiveMiddleware(allMiddleware, forgedMw);
          const chains = recomposeChains(sorted, terminals);
          activeToolChain = chains.toolChain;
          activeModelChain = chains.modelChain;
          activeStreamChain = chains.streamChain;
        }
      }
    }

    let adapterIterator: AsyncIterator<EngineEvent> | undefined;

    // Track registry watcher unsubscribe for cleanup
    let unsubRegistryWatch: (() => void) | undefined;

    try {
      // --- Session initialization ---
      agent.transition({ kind: "start" });
      await runSessionHooks(allMiddleware, "onSessionStart", sessionCtx);
      sessionStarted = true;

      // Wire registry watcher → engine events for child agent visibility.
      // Only surface events for agents whose parentId matches this agent
      // to avoid leaking sibling/unrelated activity from a shared registry.
      if (options.registry !== undefined) {
        const thisAgentId = pid.id;
        // Track child IDs so we can filter transitioned events (which lack parentId)
        const childAgentIds = new Set<string>();

        unsubRegistryWatch = options.registry.watch((watchEvent) => {
          switch (watchEvent.kind) {
            case "registered":
              // Only emit for direct children of this agent
              if (watchEvent.entry.parentId === thisAgentId) {
                childAgentIds.add(String(watchEvent.entry.agentId));
                pendingEngineEvents.push({
                  kind: "agent_spawned",
                  agentId: watchEvent.entry.agentId,
                  agentName: String(watchEvent.entry.metadata.name ?? watchEvent.entry.agentId),
                  parentAgentId: watchEvent.entry.parentId,
                });
              }
              break;
            case "transitioned":
              // Only emit for known children (transitioned events lack parentId)
              if (childAgentIds.has(String(watchEvent.agentId))) {
                pendingEngineEvents.push({
                  kind: "agent_status_changed",
                  agentId: watchEvent.agentId,
                  agentName: String(watchEvent.agentId),
                  status: watchEvent.to,
                  previousStatus: watchEvent.from,
                });
              }
              break;
            case "deregistered":
              childAgentIds.delete(String(watchEvent.agentId));
              break;
            default:
              break;
          }
        });
      }

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
        // Also emits discovery:miss when tool lookup fails (NOT_FOUND).
        const rawToolTerminal: ToolHandler = async (request) => {
          const execCtx = { session: sessionCtx, turnIndex: currentTurnIndex };
          try {
            return await runWithExecutionContext(execCtx, () => baseToolTerminal(request));
          } catch (e: unknown) {
            if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
              pendingEngineEvents.push({
                kind: "discovery:miss",
                resolverSource: forge !== undefined ? "forge+entity" : "entity",
                timestamp: Date.now(),
              });
            }
            throw e;
          }
        };
        const rawModelStreamTerminal = adapter.terminals.modelStream;

        // Create lifecycle-aware terminal handlers (cached for reuse across turns)
        cachedTerminals = createTerminalHandlers(
          agent,
          rawModelTerminal,
          rawToolTerminal,
          rawModelStreamTerminal,
        );

        // Initial chain composition (allMiddleware is already phase-sorted)
        const initialChains = recomposeChains(allMiddleware, cachedTerminals);
        activeToolChain = initialChains.toolChain;
        activeModelChain = initialChains.modelChain;
        activeStreamChain = initialChains.streamChain;

        // Entity tool descriptors (static, from assembly)
        const entityTools = agent.query<Tool>("tool:");
        const entityDescriptors: readonly ToolDescriptor[] = [...entityTools.values()].map(
          (t) => t.descriptor,
        );

        // Create deduped tools accessor (replaces manual Object.defineProperties getter)
        toolsAccessor = createDedupedToolsAccessor(entityDescriptors);

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
                toolsAccessor?.updateForged(d);
              })
              .catch((err: unknown) => {
                console.warn("[koi] forge descriptor refresh failed", err);
              });
            // Set dirty flag for turn-boundary middleware recomposition
            forgeStateDirty = true;
          });
        }

        // Build callHandlers with dynamic tools getter and chain refs
        // Capture stream chain presence — the mutable ref is read inside the closure
        const hasStreamChain = activeStreamChain !== undefined;

        // Capture toolsAccessor in a const for the getter closure
        const accessor = toolsAccessor;

        /**
         * Prepares a model request by injecting tool descriptors and capability descriptions.
         *
         * Note: Uses static `allMiddleware` (guards + user middleware) for capability injection.
         * Forged and dynamic middleware participate in the call onion (wrapModelCall/wrapToolCall)
         * but do NOT contribute to the [Active Capabilities] message. This is by design —
         * injected middleware is "wrappers-only" and joins mid-session.
         */
        const prepareRequest = (request: ModelRequest): ModelRequest => {
          // Inject tool descriptors if not already present
          const withTools: ModelRequest =
            request.tools !== undefined ? request : { ...request, tools: callHandlers.tools };
          return injectCapabilities(allMiddleware, getTurnContext(), withTools);
        };

        const streamChainProxy = (request: ModelRequest) =>
          activeStreamChain?.(getTurnContext(), prepareRequest(request));

        const callHandlers: ComposedCallHandlers = Object.defineProperties(
          {
            modelCall: (request: ModelRequest) =>
              activeModelChain(getTurnContext(), prepareRequest(request)),
            // Run-level signal is the authority at this layer. Middleware downstream
            // (e.g., sandbox) can compose additional signals via AbortSignal.any().
            // If request already carries a signal, the run signal takes precedence —
            // this is intentional: the run signal represents the caller's cancellation
            // intent, which must not be overridden by internal signal sources.
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
                return accessor.get();
              },
              enumerable: true,
              configurable: false,
            },
          },
        ) as ComposedCallHandlers;

        effectiveInput = { ...input, callHandlers, signal: runSignal };
      }

      // --- Reuse loop: wraps the main event loop for idle-wake cycling ---
      // When manifest.reuse is true, the agent transitions to idle after task
      // completion and waits for inbox messages before restarting.
      // let justified: mutable flag for idle-wake flow control
      let enterIdle = false;

      while (true) {
        adapterIterator = adapter.stream(effectiveInput)[Symbol.asyncIterator]();
        enterIdle = false;

        // --- Main event loop ---
        turnLoop: while (true) {
          // Turn-boundary suspension: if the agent is suspended, park here
          // until the registry signals a resume (reactive Promise, zero polling).
          if (options.registry !== undefined) {
            const registryEntry = await options.registry.lookup(pid.id);
            if (registryEntry?.status.phase === "suspended") {
              // Fast path: already aborted — skip suspension wait entirely
              if (runSignal.aborted) {
                agent.transition({ kind: "complete", stopReason: "interrupted" });
                return;
              }

              const resolvedPhase = await new Promise<
                "running" | "terminated" | "deregistered" | "aborted"
              >((resolve) => {
                // let justified: mutable ref to unsubscribe the suspension watcher
                let unsub: (() => void) | undefined;

                const cleanup = (): void => {
                  if (unsub !== undefined) {
                    unsub();
                    unsub = undefined;
                  }
                  runSignal.removeEventListener("abort", onSuspendAbort);
                };

                const onSuspendAbort = (): void => {
                  cleanup();
                  resolve("aborted");
                };

                // Abort signal — resolve immediately so the loop can exit gracefully
                runSignal.addEventListener("abort", onSuspendAbort, { once: true });

                unsub = options.registry?.watch((watchEvent) => {
                  if (watchEvent.kind === "deregistered" && watchEvent.agentId === pid.id) {
                    cleanup();
                    resolve("deregistered");
                    return;
                  }
                  if (watchEvent.kind === "transitioned" && watchEvent.agentId === pid.id) {
                    if (watchEvent.to === "running") {
                      cleanup();
                      resolve("running");
                    } else if (watchEvent.to === "terminated") {
                      cleanup();
                      resolve("terminated");
                    }
                  }
                });
              });

              // If resolved to a terminal state or aborted, exit the turn loop gracefully
              if (
                resolvedPhase === "terminated" ||
                resolvedPhase === "deregistered" ||
                resolvedPhase === "aborted"
              ) {
                agent.transition({ kind: "complete", stopReason: "interrupted" });
                return;
              }
            }
          }

          // Inbox drain: process queued messages at turn boundary.
          // Steer items → adapter.inject() if available; degrade to followup otherwise.
          // Collect/followup items are pushed back so middleware (e.g., inbox-middleware
          // in L2) can route them into the next turn's context during onBeforeTurn hooks.
          const inboxComponent: InboxComponent | undefined = agent.component(INBOX);
          if (inboxComponent !== undefined && inboxComponent.depth() > 0) {
            const inboxItems: readonly InboxItem[] = inboxComponent.drain();
            for (const item of inboxItems) {
              if (item.mode === "steer") {
                if (adapter.inject !== undefined) {
                  await adapter.inject({
                    senderId: item.from,
                    content: [{ kind: "text", text: item.content }],
                    timestamp: item.createdAt,
                  });
                } else {
                  // Degrade steer → followup when adapter lacks inject (L0 contract)
                  inboxComponent.push({ ...item, mode: "followup" });
                }
              } else {
                // collect/followup items: push back for middleware to access in
                // onBeforeTurn hooks (e.g., inbox-middleware in L2)
                inboxComponent.push(item);
              }
            }
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

          // Dynamic middleware refresh (e.g., debug-attach hot-wiring)
          if (options.dynamicMiddleware !== undefined && cachedTerminals !== undefined) {
            const dynamicMw = options.dynamicMiddleware();
            if (dynamicMw !== previousDynamicMw) {
              previousDynamicMw = dynamicMw;
              const sorted = resolveActiveMiddleware(
                allMiddleware,
                previousForgedMw ?? undefined,
                dynamicMw ?? undefined,
              );
              const chains = recomposeChains(sorted, cachedTerminals);
              activeToolChain = chains.toolChain;
              activeModelChain = chains.modelChain;
              activeStreamChain = chains.streamChain;
            }
          }

          // Emit turn_start event with onBeforeTurn hooks
          const turnCtx = createTurnContext({
            session: sessionCtx,
            turnIndex: currentTurnIndex,
            messages: input.kind === "messages" ? input.messages : [],
            signal: runSignal,
            approvalHandler: options.approvalHandler,
            sendStatus: options.sendStatus,
          });
          await runTurnHooks(allMiddleware, "onBeforeTurn", turnCtx);
          yield { kind: "turn_start", turnIndex: currentTurnIndex } as EngineEvent;

          // Process adapter events for this turn
          while (true) {
            const result = await adapterIterator.next();

            if (result.done) {
              // Adapter stream exhausted — idle if reusable, else terminate
              if (agent.manifest.reuse === true) {
                enterIdle = true;
                break turnLoop;
              }
              agent.transition({ kind: "complete", stopReason: "completed" });
              return;
            }

            // Drain pending events emitted by terminal wrappers (e.g., discovery:miss)
            if (pendingEngineEvents.length > 0) {
              for (const pending of pendingEngineEvents) {
                yield pending;
              }
              pendingEngineEvents.length = 0;
            }

            const event = result.value;

            if (event.kind === "turn_end") {
              currentTurnIndex = event.turnIndex + 1;
              pendingForgeRefresh = true;
              const turnEndCtx = createTurnContext({
                session: sessionCtx,
                turnIndex: event.turnIndex,
                messages: [],
                signal: runSignal,
                approvalHandler: options.approvalHandler,
                sendStatus: options.sendStatus,
              });
              await runTurnHooks(allMiddleware, "onAfterTurn", turnEndCtx);
              yield event;
              break; // → next turn in outer loop
            }

            if (event.kind === "done") {
              // Idle on normal completion if reusable; errors/timeouts always terminate
              if (agent.manifest.reuse === true && event.output.stopReason === "completed") {
                enterIdle = true;
                yield event;
                break turnLoop;
              }
              pendingForgeRefresh = false;
              agent.transition({
                kind: "complete",
                stopReason: event.output.stopReason,
                metrics: event.output.metrics,
              });
              yield event;
              return;
            }

            yield event;
          }
        }

        // --- Idle-wake: park until inbox has items, then restart ---
        if (!enterIdle) break;

        // Clean up exhausted adapter iterator before idling
        if (adapterIterator?.return !== undefined) {
          try {
            await adapterIterator.return();
          } catch (_cleanupError: unknown) {
            // Adapter cleanup failure during idle transition is non-fatal
          }
          adapterIterator = undefined;
        }

        agent.transition({ kind: "idle" });

        // Update registry so external observers see the idle state
        if (options.registry !== undefined) {
          const entry = await options.registry.lookup(pid.id);
          if (entry !== undefined && entry.status.phase !== "idle") {
            await options.registry.transition(pid.id, "idle", entry.status.generation, {
              kind: "task_completed_idle",
            });
          }
        }

        // Wait for inbox messages, abort signal, or external registry wake
        const idleInbox: InboxComponent | undefined = agent.component(INBOX);
        await new Promise<void>((resolve) => {
          // Fast path: inbox already has items (pushed during final turn)
          if (idleInbox !== undefined && idleInbox.depth() > 0) {
            resolve();
            return;
          }
          // Fast path: already aborted
          if (runSignal.aborted) {
            resolve();
            return;
          }

          // let justified: mutable timer ref for idle polling
          let timer: ReturnType<typeof setInterval> | undefined;
          // let justified: mutable unsubscribe ref for registry watcher
          let unsub: (() => void) | undefined;

          const cleanup = (): void => {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            if (unsub !== undefined) {
              unsub();
              unsub = undefined;
            }
            runSignal.removeEventListener("abort", onIdleAbort);
          };

          const onIdleAbort = (): void => {
            cleanup();
            resolve();
          };

          // Abort signal — resolve immediately so finally block can terminate
          runSignal.addEventListener("abort", onIdleAbort, { once: true });

          // Poll inbox at 50ms — InboxComponent has no push notification, so we
          // use a short interval to minimise wake latency. The timer is unref'd so
          // it does not keep the process alive.
          timer = setInterval(() => {
            if (idleInbox !== undefined && idleInbox.depth() > 0) {
              cleanup();
              resolve();
            }
          }, 50);
          // Bun's setInterval returns a Timer with .unref() — prevent keeping process alive
          unrefTimer(timer);

          // Also watch for external wake via registry (e.g., inbox push + registry transition)
          if (options.registry !== undefined) {
            unsub = options.registry.watch((watchEvent) => {
              if (
                watchEvent.kind === "transitioned" &&
                watchEvent.agentId === pid.id &&
                watchEvent.to === "running"
              ) {
                cleanup();
                resolve();
              }
            });
          }
        });

        // If aborted while idle, exit the reuse loop — finally block handles cleanup
        if (runSignal.aborted) break;

        // Resume from idle
        agent.transition({ kind: "resume" });

        // Update registry back to running
        if (options.registry !== undefined) {
          const entry = await options.registry.lookup(pid.id);
          if (entry !== undefined && entry.status.phase === "idle") {
            await options.registry.transition(pid.id, "running", entry.status.generation, {
              kind: "inbox_wake",
            });
          }
        }
        // Continue reuseLoop → creates new adapter stream, drains inbox at turn boundary
      }
    } catch (error: unknown) {
      // Guard error → convert to a done event
      if (error instanceof KoiRuntimeError) {
        const stopReason = error.code === "TIMEOUT" ? "max_turns" : "error";
        agent.transition({ kind: "complete", stopReason });
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
        yield doneEvent;
        return;
      }

      // Unexpected error → transition and re-throw
      agent.transition({ kind: "error", error });
      throw error;
    } finally {
      running = false;
      if (unsubRegistryWatch !== undefined) unsubRegistryWatch();
      cleanupForgeSubscription();
      runSignal.removeEventListener("abort", onAbort);

      // Clean up adapter iterator (important on early return / break)
      if (adapterIterator?.return !== undefined) {
        try {
          await adapterIterator.return();
        } catch (_cleanupError: unknown) {
          // Adapter cleanup failure is non-fatal
        }
      }

      // Transition agent if not already terminated (e.g., consumer break / return / abort)
      if (agent.state === "running" || agent.state === "idle") {
        agent.transition({ kind: "complete", stopReason: "interrupted" });
      }

      // Session end hooks (if session was started)
      if (sessionStarted) {
        try {
          await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
        } catch (sessionEndError: unknown) {
          console.warn("[koi] onSessionEnd failed during cleanup", { cause: sessionEndError });
        }
      }
    }
  }

  // --- 7. Build runtime ---
  const runtime: KoiRuntime = {
    agent,
    conflicts,

    run(input: EngineInput): AsyncIterable<EngineEvent> {
      if (running) {
        throw KoiRuntimeError.from("VALIDATION", "Agent is already running");
      }
      running = true;
      return { [Symbol.asyncIterator]: () => streamEvents(input) };
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await adapter.dispose?.();
    },
  };

  return runtime;
}
