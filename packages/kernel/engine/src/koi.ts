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
  EngineStopReason,
  GovernanceController,
  InboundMessage,
  InboxComponent,
  InboxItem,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
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
import {
  DEFAULT_MAX_STOP_RETRIES,
  GOVERNANCE,
  INBOX,
  runId,
  sessionId,
  toolToken,
} from "@koi/core";
import type { DebugInstrumentation, TerminalHandlers } from "@koi/engine-compose";
import {
  composeExtensions,
  computeCapabilityBanner,
  createDebugInstrumentation,
  createDefaultGuardExtension,
  recomposeChains,
  resolveActiveMiddleware,
  runPermissionDecisionHooks,
  runSessionHooks,
  runStopGate,
  runTurnHooks,
} from "@koi/engine-compose";
import { createGovernanceExtension, createGovernanceProvider } from "@koi/engine-reconcile";
import { KoiRuntimeError } from "@koi/errors";
import {
  type ChildSpanRecord,
  runWithExecutionContext,
  runWithSpanRecorder,
} from "@koi/execution-context";
import { AgentEntity } from "./agent-entity.js";
import { createBrickRequiresExtension } from "./brick-requires-extension.js";
import { createTerminalHandlers } from "./compose-bridge.js";
import { createDedupedToolsAccessor } from "./deduped-tools-accessor.js";
import { createTurnContext, generatePid, unrefTimer } from "./koi-helpers.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

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
    ...(options.toolExecution !== undefined ? { toolExecution: options.toolExecution } : {}),
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
  const { sorted: allMiddleware, provenanceHints: staticProvenanceHints } = resolveActiveMiddleware(
    [...composed.guardMiddleware, ...middleware],
  );

  // --- 3b. Create debug instrumentation if enabled ---
  const debugInstrumentation: DebugInstrumentation | undefined =
    options.debug?.enabled === true ? createDebugInstrumentation(options.debug) : undefined;

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
  // let justified: mutable turn counter needed by defaultToolTerminal for debug instrumentation
  let outerCurrentTurnIndex = 0;

  const defaultToolTerminal = async (request: ToolRequest): Promise<ToolResponse> => {
    // Forge-first: forged tools shadow entity tools (Agent-forged > Bundled)
    const resolveStart = performance.now();
    const fromForge = forge !== undefined ? await forge.resolveTool(request.toolId) : undefined;
    const tool: Tool | undefined = fromForge ?? agent.component(toolToken(request.toolId));
    const resolveMs = performance.now() - resolveStart;

    debugInstrumentation?.recordResolve({
      toolId: request.toolId,
      source: fromForge !== undefined ? "forged" : tool !== undefined ? "entity" : "miss",
      durationMs: resolveMs,
      turnIndex: outerCurrentTurnIndex,
    });

    if (tool === undefined) {
      throw KoiRuntimeError.from("NOT_FOUND", `Tool not found: "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    }
    const output = await tool.execute(
      request.input,
      request.signal !== undefined ? { signal: request.signal } : undefined,
    );

    // Enrich response metadata with provenance when the tool has a server origin (#1464)
    const serverName = tool.descriptor.server;
    const toolOrigin = tool.descriptor.origin ?? tool.origin;
    const provenance =
      serverName !== undefined
        ? {
            provenance: {
              system: toolOrigin === "operator" ? ("mcp" as const) : ("builtin" as const),
              server: serverName,
            },
          }
        : {};
    const merged = {
      ...(request.metadata !== undefined ? (request.metadata as Record<string, unknown>) : {}),
      ...provenance,
    } as Record<string, unknown>;
    return Object.keys(merged).length > 0 ? { output, metadata: merged as JsonObject } : { output };
  };

  // --- 5. Track disposal ---
  // let justified: mutable flag for one-shot dispose guard
  let disposed = false;
  // let justified: mutable flag for concurrent run() guard
  let running = false;
  // #1742: Promise that resolves when the active run's streamEvents finally
  // block has settled (running cleared, hooks fired, adapter cleaned up).
  // cycleSession() awaits this so a /clear that races a just-aborted run
  // doesn't reject — it waits for the prior run to fully unwind first.
  // let justified: mutable per-run promise, replaced on every run()
  let currentRunSettled: Promise<void> = Promise.resolve();
  // let justified: mutable resolver for currentRunSettled, captured in run()
  let currentRunResolveSettled: (() => void) | undefined;

  // #1742: bounded fallback for cycleSession()/dispose() so a
  // non-cooperative tool/stream that ignores abort can't deadlock the
  // host. After the timeout the runtime is marked POISONED — any
  // future run() rejects with a clear error so the host knows to
  // recreate the runtime instead of submitting another turn into a
  // wedged session. 5 seconds is generous for cooperative cleanup but
  // short enough to keep the TUI responsive on /clear.
  const LIFECYCLE_SETTLE_TIMEOUT_MS = 5000;
  // let justified: mutable poison flag set on settle timeout
  let poisoned = false;
  /**
   * Race `currentRunSettled` against the lifecycle settle timeout.
   * Returns `"settled"` when the run unwound first, `"timeout"` when
   * the timer fired. Either branch CLEARS the timer so a successful
   * settle does not leave a dangling timeout that poisons the runtime
   * 5 seconds later (#1742, round 7 review).
   */
  async function awaitSettleOrTimeout(): Promise<"settled" | "timeout"> {
    // let justified: mutable timer handle owned by the timeout side
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        poisoned = true;
        console.warn(
          `[koi] lifecycle settle timeout (${LIFECYCLE_SETTLE_TIMEOUT_MS}ms) — runtime poisoned, an in-flight tool ignored abort. Caller must dispose and recreate the runtime before submitting another turn.`,
        );
        resolve("timeout");
      }, LIFECYCLE_SETTLE_TIMEOUT_MS);
      // Unref so the timer doesn't pin the event loop on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([currentRunSettled.then(() => "settled" as const), timeoutPromise]);
    } finally {
      // Always cancel the timer. If the settle won the race the timer
      // would otherwise still fire ~5s later and incorrectly poison
      // the runtime even though cleanup already completed normally.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  // Session ID created at factory scope so runtime.sessionId can reference it.
  // Format: "agent:{agentId}:{uuid}" — trust boundary is parseable from the ID.
  const factorySessionId: SessionId = sessionId(`agent:${pid.id}:${crypto.randomUUID()}`);

  // --- Session lifecycle (runtime-scoped, NOT per-run) ---
  //
  // The agent "session" spans the lifetime of this runtime instance — from
  // createKoi() to runtime.dispose(). Middleware hooks onSessionStart /
  // onSessionEnd fire exactly once per runtime, not once per run(). This
  // matches the stable factorySessionId (same ID across every run on this
  // runtime) and lets session-scoped state (caches, always-allow grants,
  // trackers) survive turn boundaries as the hook names imply.
  //
  // #1742 regression: firing onSessionEnd at the end of every run() was
  // nuking `@koi/middleware-permissions`'s alwaysAllowedBySession between
  // turns, so pressing "a" (Always allow Bash this session) only persisted
  // for the current run. Second turns re-prompted, the prompt timed out,
  // the tool was denied, and the user saw "no reply after second message".
  //
  // Hosts that need to clear session state between user-facing conversations
  // (e.g. TUI /clear, session:new) already call explicit middleware APIs
  // like `clearSessionApprovals(sessionId)` — they never relied on the
  // per-run onSessionEnd to do it for them.
  const lifecycleSessionCtx: SessionContext = {
    agentId: pid.id,
    sessionId: factorySessionId,
    runId: runId(crypto.randomUUID()),
    ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
    ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
    metadata: {},
  };
  // let justified: mutable flags guarding one-shot lifecycle hook firing
  let lifecycleSessionStarted = false;
  let lifecycleSessionEnded = false;
  // #1742: capture the EXACT SessionContext used at onSessionStart so the
  // matching onSessionEnd carries the same identity (same runId in
  // particular). Middleware that pairs start/end records by ctx.runId
  // (e.g. @koi/middleware-report) breaks if the two halves don't agree.
  // Reset to undefined on cycleSession so the next session captures fresh.
  // let justified: mutable per-session ctx, captured in streamEvents
  let activeSessionCtx: SessionContext | undefined;

  // --- 6. Async generator: produces EngineEvents for a single run() invocation ---
  async function* streamEvents(input: EngineInput): AsyncGenerator<EngineEvent> {
    const sessionStartedAt = Date.now();
    // let justified: mutable turn counter incremented on turn_end
    let currentTurnIndex = 0;
    // Sync the outer mutable ref so defaultToolTerminal can read it
    outerCurrentTurnIndex = 0;

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
    let cachedTerminals: TerminalHandlers | undefined;

    // let justified: previous forge middleware ref for identity-based skip
    let previousForgedMw: readonly KoiMiddleware[] | undefined;

    // let justified: tools accessor for cooperating adapters (set once at session start)
    let toolsAccessor: ReturnType<typeof createDedupedToolsAccessor> | undefined;

    // let justified: pending engine events emitted by terminal wrappers (e.g., discovery:miss)
    const pendingEngineEvents: EngineEvent[] = [];

    const rid: RunId = runId(crypto.randomUUID());
    const sessionCtx: SessionContext = {
      agentId: pid.id,
      sessionId: factorySessionId,
      runId: rid,
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
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

    /** Re-compose chains when dynamic sources change. Updates mutable chain refs in-place. */
    function applyRecomposition(
      forgedMw: readonly KoiMiddleware[] | undefined,
      dynamicMw: readonly KoiMiddleware[] | undefined,
      terminals: TerminalHandlers,
    ): void {
      const { sorted, provenanceHints } = resolveActiveMiddleware(
        allMiddleware,
        forgedMw ?? undefined,
        dynamicMw ?? undefined,
      );
      const chains = recomposeChains(sorted, terminals, debugInstrumentation, provenanceHints);
      activeToolChain = chains.toolChain;
      activeModelChain = chains.modelChain;
      activeStreamChain = chains.streamChain;
    }

    /** Refresh forged descriptors and re-compose middleware if forge runtime is provided. */
    async function refreshForgeState(terminals: TerminalHandlers): Promise<void> {
      if (forge === undefined) return;

      // Refresh forged tool descriptors
      const prevDescCount = forgedDescriptorsCache.length;
      forgedDescriptorsCache = await forge.toolDescriptors();
      const newDescCount = forgedDescriptorsCache.length;
      toolsAccessor?.updateForged(forgedDescriptorsCache);

      // Re-compose middleware chains only when forged middleware actually changed
      // let justified: mutable flag tracking whether middleware was recomposed this refresh
      let middlewareRecomposed = false;
      if (forge.middleware !== undefined) {
        const forgedMw = await forge.middleware();
        if (forgedMw !== previousForgedMw) {
          middlewareRecomposed = true;
          previousForgedMw = forgedMw;
          applyRecomposition(forgedMw, previousDynamicMw ?? undefined, terminals);
        }
      }

      debugInstrumentation?.recordForgeRefresh({
        descriptorsChanged: newDescCount !== prevDescCount,
        descriptorCount: newDescCount,
        middlewareRecomposed,
        timestamp: Date.now(),
        turnIndex: currentTurnIndex,
      });
    }

    let adapterIterator: AsyncIterator<EngineEvent> | undefined;

    // Track registry watcher unsubscribe for cleanup
    let unsubRegistryWatch: (() => void) | undefined;

    try {
      // --- Run / session initialization ---
      // onSessionStart fires exactly once across the runtime's lifetime,
      // on the first run() call, with this run's sessionCtx (tests rely on
      // `ctx.runId` captured here matching the first run's per-turn runId).
      // onSessionEnd is deferred entirely to runtime.dispose — see the
      // factorySessionId block above (#1742) — and uses a separate
      // runtime-scoped ctx because dispose may happen long after any run.
      agent.transition({ kind: "start" });
      if (!lifecycleSessionStarted) {
        lifecycleSessionStarted = true;
        // #1742: capture this run's sessionCtx so the matching
        // onSessionEnd (fired from cycleSession or dispose) reuses the
        // same identity — particularly the per-run runId — to keep
        // start/end record pairing intact for middleware-report and
        // friends. Cleared on cycleSession() re-arm.
        activeSessionCtx = sessionCtx;
        await runSessionHooks(allMiddleware, "onSessionStart", sessionCtx);
      }

      // #1742: per-run iteration budget reset. Opt-in via
      // `options.resetIterationBudgetPerRun` so cumulative session-level
      // budget enforcement remains the default for batch/headless hosts.
      // Interactive hosts (TUI) opt in to give each user submit a fresh
      // turn/token/cost/duration budget. Spawn counts and rolling
      // error-rate windows are NOT reset (runtime-scoped resources).
      if (options.resetIterationBudgetPerRun === true) {
        const govCtl = agent.component<GovernanceController>(GOVERNANCE);
        if (govCtl !== undefined) {
          await govCtl.record({ kind: "iteration_reset" });
        }
      }

      // Wire registry watcher → engine events for child agent visibility.
      // Only surface events for agents whose parentId matches this agent
      // to avoid leaking sibling/unrelated activity from a shared registry.
      if (options.registry !== undefined) {
        const thisAgentId = pid.id;
        // Track child IDs + names so we can filter and label transitioned events
        // (transitioned events lack parentId and metadata)
        const childAgentNames = new Map<string, string>();

        unsubRegistryWatch = options.registry.watch((watchEvent) => {
          switch (watchEvent.kind) {
            case "registered":
              // Only emit for direct children of this agent
              if (watchEvent.entry.parentId === thisAgentId) {
                const childName = String(
                  watchEvent.entry.metadata.name ?? watchEvent.entry.agentId,
                );
                childAgentNames.set(String(watchEvent.entry.agentId), childName);
                pendingEngineEvents.push({
                  kind: "agent_spawned",
                  agentId: watchEvent.entry.agentId,
                  agentName: childName,
                  parentAgentId: watchEvent.entry.parentId,
                });
              }
              break;
            case "transitioned": {
              // Only emit for known children (transitioned events lack parentId)
              const name = childAgentNames.get(String(watchEvent.agentId));
              if (name !== undefined) {
                pendingEngineEvents.push({
                  kind: "agent_status_changed",
                  agentId: watchEvent.agentId,
                  agentName: name,
                  status: watchEvent.to,
                  previousStatus: watchEvent.from,
                });
              }
              break;
            }
            case "deregistered":
              childAgentNames.delete(String(watchEvent.agentId));
              break;
            default:
              break;
          }
        });
      }

      // Cached capability banner for prompt-cache stability (#1554). Computed
      // once on the first model call of an answer attempt and reused on
      // stop-gate retries. This replaces the previous skipCapabilityInjection
      // flag: instead of removing the banner on retries (which broke the
      // system-prompt prefix cache), we reuse the identical cached banner.
      //
      // #1493 regression safety: the cached banner is byte-identical to the
      // initial call — the model does NOT receive new capability text to
      // fixate on. Combined with the stop-gate feedback message (line ~830)
      // that explicitly forbids parroting capabilities, this is strictly
      // safer than recomputing a fresh banner. If a future model consistently
      // parrots the cached banner despite the instruction, restore the
      // skipCapabilityInjection guard as a fallback.
      //
      // Staleness note: capability descriptions from stateful middleware
      // (e.g., retry budgets, goal progress) are frozen for the retry. This
      // is intentional — stop-gate retries happen within milliseconds of the
      // initial call for the same question, so capability state is effectively
      // unchanged. Recomputing would break prefix cache continuity.
      // let justified: mutable cache coordinated between prepareRequest and stop-gate retry
      let cachedCapabilityBanner: string | undefined;
      // let justified: mutable flag — false until first prepareRequest call computes the banner
      let bannerCached = false;

      // Wire terminals → middleware → callHandlers if adapter is cooperating
      // let justified: effectiveInput may be replaced with callHandlers-augmented input
      let effectiveInput: EngineInput = { ...input, signal: runSignal };
      // let justified: mutable per-turn messages — updated on stop-gate retries
      // so cooperating-adapter middleware sees the same messages as onBeforeTurn
      let activeTurnMessages: readonly InboundMessage[] =
        input.kind === "messages" ? input.messages : [];

      // Snapshot the original user prompt for stop-gate retries: when the
      // initial input is `kind: "text"`, activeTurnMessages is empty (the
      // bridge builds its own conversation), so stop-gate retries would lose
      // the original question. This snapshot is prepended to pendingStopInput
      // so the retry adapter sees the full conversation context (#1493).
      const originalUserMessages: readonly InboundMessage[] =
        input.kind === "text" && input.text.length > 0
          ? [
              {
                senderId: "user",
                timestamp: Date.now(),
                content: [{ kind: "text" as const, text: input.text }],
              },
            ]
          : input.kind === "messages"
            ? input.messages
            : [];

      if (adapter.terminals) {
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
            messages: activeTurnMessages,
            signal: runSignal,
            approvalHandler: options.approvalHandler,
            sendStatus: options.sendStatus,
            dispatchPermissionDecision: (query, decision) => {
              void runPermissionDecisionHooks(
                allMiddleware,
                getTurnContext(),
                query,
                decision,
              ).catch((e: unknown) => {
                console.warn("[koi] onPermissionDecision hook error:", e);
              });
            },
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
          const collectedSpans: ChildSpanRecord[] = [];
          const recorder = {
            record: (span: ChildSpanRecord): void => {
              collectedSpans.push(span);
            },
          };
          try {
            const result = await runWithSpanRecorder(recorder, () =>
              runWithExecutionContext(execCtx, () => baseToolTerminal(request)),
            );
            if (collectedSpans.length > 0) {
              debugInstrumentation?.recordToolChildSpans({
                turnIndex: currentTurnIndex,
                toolId: request.toolId,
                children: collectedSpans,
              });
            }
            return result;
          } catch (e: unknown) {
            if (collectedSpans.length > 0) {
              debugInstrumentation?.recordToolChildSpans({
                turnIndex: currentTurnIndex,
                toolId: request.toolId,
                children: collectedSpans,
              });
            }
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
          debugInstrumentation,
          () => currentTurnIndex,
        );

        // Initial chain composition (allMiddleware is already phase-sorted)
        const initialChains = recomposeChains(
          allMiddleware,
          cachedTerminals,
          debugInstrumentation,
          staticProvenanceHints,
        );
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
         * but do NOT contribute to the [Active Capabilities] banner prepended to systemPrompt.
         * This is by design — injected middleware is "wrappers-only" and joins mid-session.
         *
         * Capability injection is suppressed on stop-gate retries: the model already
         * saw the banner on the initial call, and re-injecting on each retry causes
         * chatty models (e.g. Gemini) to fixate on the banner and echo it back as
         * output instead of answering the user's question (#1493).
         */
        const prepareRequest = (request: ModelRequest): ModelRequest => {
          // Inject tool descriptors if not already present
          const withTools: ModelRequest =
            request.tools !== undefined ? request : { ...request, tools: callHandlers.tools };
          // Compute capability banner once per answer attempt and cache it.
          // Reused on stop-gate retries for prompt-cache stability (#1554).
          if (!bannerCached) {
            cachedCapabilityBanner = computeCapabilityBanner(allMiddleware, getTurnContext());
            bannerCached = true;
          }
          if (cachedCapabilityBanner === undefined) return withTools;
          const systemPrompt =
            withTools.systemPrompt !== undefined
              ? `${cachedCapabilityBanner}\n\n${withTools.systemPrompt}`
              : cachedCapabilityBanner;
          return { ...withTools, systemPrompt };
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
      // let justified: mutable counter for stop-gate re-prompts across the session
      let stopRetryCount = 0;
      const maxStopRetries = input.maxStopRetries ?? DEFAULT_MAX_STOP_RETRIES;
      // let justified: mutable deferred input for stop-gate retry (created after turn boundary)
      let pendingStopInput: EngineInput | undefined;

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
              applyRecomposition(
                previousForgedMw ?? undefined,
                dynamicMw ?? undefined,
                cachedTerminals,
              );
            }
          }

          // Deferred stop-gate retry: create adapter stream AFTER forge/middleware
          // refresh so the retry turn sees updated tools and middleware state.
          if (pendingStopInput !== undefined) {
            adapterIterator = adapter.stream(pendingStopInput)[Symbol.asyncIterator]();
          }

          // Emit turn_start event with onBeforeTurn hooks.
          // Update activeTurnMessages so cooperating-adapter middleware
          // (getTurnContext) sees the same messages as onBeforeTurn hooks.
          const turnMessages =
            pendingStopInput?.kind === "messages"
              ? pendingStopInput.messages
              : input.kind === "messages"
                ? input.messages
                : [];
          activeTurnMessages = turnMessages;
          pendingStopInput = undefined;
          const turnCtx = createTurnContext({
            session: sessionCtx,
            turnIndex: currentTurnIndex,
            messages: turnMessages,
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
              outerCurrentTurnIndex = currentTurnIndex;
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
              debugInstrumentation?.onTurnEnd(event.turnIndex);
              yield event;
              break; // → next turn in outer loop
            }

            if (event.kind === "done") {
              // Stop gate: when model completes normally, check if any middleware
              // blocks completion before yielding the done event.
              if (event.output.stopReason === "completed" && stopRetryCount < maxStopRetries) {
                const stopCtx = createTurnContext({
                  session: sessionCtx,
                  turnIndex: currentTurnIndex,
                  messages: [],
                  signal: runSignal,
                  approvalHandler: options.approvalHandler,
                  sendStatus: options.sendStatus,
                });
                const gateResult = await runStopGate(allMiddleware, stopCtx);
                if (gateResult.kind === "block") {
                  stopRetryCount++;
                  // Re-anchor the retry on the user's original request. Vague feedback
                  // like "address this" lets the model drift onto nearby context —
                  // in particular, the system-prompt capability banner — and parrot
                  // it back as output (#1493). Anchoring explicitly on "the user's
                  // most recent request" and forbidding capability/system commentary
                  // keeps the retry on task.
                  const blockMessage: InboundMessage = {
                    senderId: "system",
                    content: [
                      {
                        kind: "text",
                        text: `[Stop hook feedback]: ${gateResult.reason}\n\nContinue responding to the user's most recent request. Address the feedback by correcting your previous response — do not describe your tools, your active capabilities, or this feedback itself. Produce only the answer the user asked for.`,
                      },
                    ],
                    timestamp: Date.now(),
                  };

                  // Inject block reason via adapter.inject() if available
                  // as a best-effort hint to the running adapter state.
                  if (adapter.inject !== undefined) {
                    await adapter.inject(blockMessage);
                  }
                  // Always include the block message in the retry stream input.
                  // inject() state may not survive across stream() restarts,
                  // so pendingStopInput is the guaranteed delivery path.
                  //
                  // Include the original user messages before the block feedback
                  // so the retry adapter sees the full conversation context — not
                  // just the feedback in isolation. Without the original user
                  // question, the model has no task to re-anchor on (#1493).
                  // Uses originalUserMessages (snapshot at session start) because
                  // activeTurnMessages gets overwritten to [] at turn boundaries
                  // for text inputs.
                  pendingStopInput = {
                    kind: "messages",
                    messages: [...originalUserMessages, blockMessage],
                    ...(effectiveInput.callHandlers !== undefined
                      ? { callHandlers: effectiveInput.callHandlers }
                      : {}),
                    signal: runSignal,
                  };
                  // Clean up previous adapter iterator before retry
                  if (adapterIterator?.return !== undefined) {
                    try {
                      await adapterIterator.return();
                    } catch (_cleanupError: unknown) {
                      // Cleanup failure is non-fatal
                    }
                  }

                  // Emit turn_end for the blocked turn (mirrors L2 turn-runner pattern).
                  // stopBlocked flag lets middleware distinguish vetoes from real completions.
                  const blockedTurnIndex = currentTurnIndex;
                  const blockedTurnCtx = createTurnContext({
                    session: sessionCtx,
                    turnIndex: blockedTurnIndex,
                    messages: [],
                    signal: runSignal,
                    approvalHandler: options.approvalHandler,
                    sendStatus: options.sendStatus,
                    stopBlocked: true,
                    stopGateReason: gateResult.reason,
                    ...(gateResult.blockedBy !== undefined
                      ? { stopGateBlockedBy: gateResult.blockedBy }
                      : {}),
                  });
                  await runTurnHooks(allMiddleware, "onAfterTurn", blockedTurnCtx);
                  debugInstrumentation?.onTurnEnd(blockedTurnIndex);
                  yield {
                    kind: "turn_end",
                    turnIndex: blockedTurnIndex,
                    stopBlocked: true,
                  } as EngineEvent;

                  // Advance turn index for the retry turn
                  currentTurnIndex = blockedTurnIndex + 1;
                  outerCurrentTurnIndex = currentTurnIndex;
                  pendingForgeRefresh = true;

                  // Continue the turn loop — don't yield done, don't return
                  break; // breaks inner while(true), continues turnLoop
                }
              }

              // Normalize done metrics to include stop-gate retry turns so the
              // terminal record matches the emitted event stream.
              const normalizedMetrics =
                stopRetryCount > 0
                  ? { ...event.output.metrics, turns: event.output.metrics.turns + stopRetryCount }
                  : event.output.metrics;
              const normalizedDone: EngineEvent = {
                kind: "done",
                output: { ...event.output, metrics: normalizedMetrics },
              };

              // Idle on normal completion if reusable; errors/timeouts always terminate
              if (agent.manifest.reuse === true && event.output.stopReason === "completed") {
                enterIdle = true;
                // Reset per-completion retry counter so subsequent idle-wake
                // completions don't accumulate stale stop-gate retries. Likewise
                // re-enable capability injection for the next completion's first
                // call.
                stopRetryCount = 0;
                bannerCached = false;
                cachedCapabilityBanner = undefined;
                yield normalizedDone;
                break turnLoop;
              }
              pendingForgeRefresh = false;
              agent.transition({
                kind: "complete",
                stopReason: event.output.stopReason,
                metrics: normalizedMetrics,
              });
              yield normalizedDone;
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
        // If the run signal was aborted (user cancel, shutdown, token limit),
        // use "interrupted" regardless of error code — the abort is the root cause.
        const stopReason: EngineStopReason = runSignal.aborted
          ? "interrupted"
          : error.code === "TIMEOUT"
            ? "max_turns"
            : "error";
        agent.transition({ kind: "complete", stopReason });
        // #1742: surface the guard error to the user as visible assistant text
        // so the TUI (and any other consumer) doesn't render an empty reply
        // when governance trips (turn count, token budget, duration, rate
        // limit, etc.). Previously `content: []` was emitted, and the
        // preceding turn_end had already closed the active assistant block,
        // so the reducer had nowhere to attach the error. The user just saw
        // a silent stop. Emitting a `text_delta` before the `done` opens a
        // fresh assistant block with the error reason, matching the
        // behavior of engine-adapter's synthetic-done path for turn-runner
        // errors (engine-adapter.ts:explainNonCompletedStop).
        const reason =
          stopReason === "max_turns"
            ? `[Turn stopped: ${error.message}. Raise the session budget or resubmit to continue.]`
            : stopReason === "interrupted"
              ? "[Turn interrupted before the model produced a reply.]"
              : `[Turn failed: ${error.message}.]`;
        yield { kind: "text_delta", delta: `\n${reason}\n` } as EngineEvent;
        const doneEvent: EngineEvent = {
          kind: "done",
          output: {
            content: [{ kind: "text", text: reason }],
            stopReason,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: Date.now() - sessionStartedAt,
            },
            metadata: { errorMessage: error.message },
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

      // #1742: signal that this run has fully unwound so a queued
      // cycleSession() / dispose() can safely proceed.
      currentRunResolveSettled?.();
      currentRunResolveSettled = undefined;

      // #1742: onSessionEnd fires once from runtime.dispose, NOT at the end
      // of every run(). See factorySessionId block above.
    }
  }

  // --- 7. Build runtime ---
  const runtime: KoiRuntime = {
    agent,
    sessionId: factorySessionId as string,
    conflicts,

    run(input: EngineInput): AsyncIterable<EngineEvent> {
      if (poisoned) {
        // #1742: a previous cycleSession()/dispose() hit the lifecycle
        // settle timeout — an in-flight tool ignored abort and the
        // runtime is in an inconsistent state. Refuse new submits so
        // the host swaps in a fresh runtime instead of layering work
        // onto a wedged one.
        throw KoiRuntimeError.from(
          "VALIDATION",
          "Runtime is poisoned: a prior cleanup timed out waiting for a non-cooperative tool. Dispose and recreate.",
        );
      }
      if (running) {
        throw KoiRuntimeError.from("VALIDATION", "Agent is already running");
      }
      running = true;
      // #1742: track when this run's finally block has fully settled so
      // cycleSession can wait for an aborted run to fully unwind before
      // cycling middleware lifecycle. resolveSettled is called from the
      // finally block in streamEvents.
      currentRunSettled = new Promise<void>((resolve) => {
        currentRunResolveSettled = resolve;
      });
      return { [Symbol.asyncIterator]: () => streamEvents(input) };
    },

    cycleSession: async (): Promise<void> => {
      // #1742: refresh session-scoped middleware state without tearing down
      // the runtime. Used by hosts (e.g. TUI `/clear`, `session:new`) that
      // expose user-visible conversation boundaries inside one process.
      //
      // Hosts typically call this AFTER aborting the active run signal but
      // BEFORE the run's finally block has fully unwound. To avoid racing
      // that cleanup, wait for `currentRunSettled` (resolved from the
      // streamEvents finally) instead of throwing on `running === true`.
      //
      // The wait is bounded by `LIFECYCLE_SETTLE_TIMEOUT_MS`. If the timeout
      // fires we FAIL CLOSED: poison the runtime and throw, so the host
      // cannot accidentally clear/rotate session state while the old run
      // is still executing. The previous design ran cleanup anyway and
      // depended on the host noticing the poisoned flag on the next run(),
      // but that left a window where late tool/model callbacks could write
      // into freshly re-armed middleware state. Failing closed here forces
      // hosts to dispose and recreate the runtime when a tool ignores
      // abort.
      if (running) {
        const result = await awaitSettleOrTimeout();
        if (result === "timeout") {
          throw KoiRuntimeError.from(
            "TIMEOUT",
            `Runtime is wedged: in-flight run ignored abort for ${LIFECYCLE_SETTLE_TIMEOUT_MS}ms. Dispose and recreate.`,
          );
        }
      }
      if (lifecycleSessionStarted && !lifecycleSessionEnded) {
        try {
          await runSessionHooks(
            allMiddleware,
            "onSessionEnd",
            activeSessionCtx ?? lifecycleSessionCtx,
          );
        } catch (sessionEndError: unknown) {
          console.warn("[koi] onSessionEnd failed during cycleSession", {
            cause: sessionEndError,
          });
        }
      }
      // #1742: clear per-session governance state (rolling tool-error
      // window, total-call window, iteration counters) so the next
      // conversation isn't immediately blocked by error-rate history
      // inherited from the previous one. Token usage, accumulated cost,
      // and spawn counts remain CUMULATIVE so process-level safety/
      // spend ceilings still hold across the runtime lifetime.
      const govCtl = agent.component<GovernanceController>(GOVERNANCE);
      if (govCtl !== undefined) {
        await govCtl.record({ kind: "session_reset" });
      }
      // Reset the lifecycle flag so the NEXT run() fires onSessionStart again
      // with a fresh sessionCtx (its first turn's runId, like the original
      // first-run path). Until that next run, the runtime is in a quiescent
      // pre-session state — same as immediately after createKoi() returned.
      lifecycleSessionStarted = false;
      lifecycleSessionEnded = false;
      activeSessionCtx = undefined;
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      // #1742: if a run is still in flight, wait for its finally to
      // unwind before tearing down session/adapter state. Without this,
      // dispose() races the active stream's middleware/adapter cleanup
      // and can flush session-scoped state (or destroy the adapter
      // backing an active iterator) underneath an in-progress event.
      //
      // Bounded by `LIFECYCLE_SETTLE_TIMEOUT_MS` so a non-cooperative
      // tool can't deadlock shutdown. Unlike `cycleSession`, dispose
      // proceeds with cleanup even on timeout because the caller has
      // already committed to throwing the runtime away — leaving it
      // half-disposed would be worse. State corruption from the
      // late-running tool is accepted as collateral damage; the
      // poisoned runtime warning makes the situation visible.
      // Caller is responsible for first aborting the run signal so
      // the stream actually terminates promptly.
      if (running) {
        const result = await awaitSettleOrTimeout();
        if (result === "timeout") {
          console.warn(
            "[koi] dispose proceeding after settle timeout — late tool callbacks may corrupt downstream state",
          );
        }
      }
      // #1742: session lifecycle ends when the runtime is disposed — not at
      // the end of every run(). Fire onSessionEnd here so middleware
      // session-scoped state (caches, always-allow grants, trackers) is
      // dropped exactly once, when the agent session truly ends.
      if (lifecycleSessionStarted && !lifecycleSessionEnded) {
        lifecycleSessionEnded = true;
        try {
          await runSessionHooks(
            allMiddleware,
            "onSessionEnd",
            activeSessionCtx ?? lifecycleSessionCtx,
          );
        } catch (sessionEndError: unknown) {
          console.warn("[koi] onSessionEnd failed during dispose", { cause: sessionEndError });
        }
      }
      await adapter.dispose?.();
    },

    ...(debugInstrumentation !== undefined
      ? {
          debug: {
            getTrace: (turnIndex: number) => debugInstrumentation.getTrace(turnIndex),
            getInventory: (extraItems) =>
              debugInstrumentation.buildInventory(pid.id, extraItems ?? []),
          },
        }
      : {}),
  };

  return runtime;
}
