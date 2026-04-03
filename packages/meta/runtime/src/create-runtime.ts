import type {
  ApprovalHandler,
  ChannelAdapter,
  ComposedCallHandlers,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RichTrajectoryStep,
  ToolDescriptor,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
  TurnId,
} from "@koi/core";
import { runId, sessionId } from "@koi/core";
import { createInMemorySpawnLedger, createSpawnToolProvider } from "@koi/engine";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";

// Process-wide shared spawn ledger — all runtimes on this process account against
// the same cap when no explicit shared ledger is provided via RuntimeConfig.spawnLedger.
// A per-runtime private ledger would let multiple runtimes exceed the intended global limit.
// Capacity is derived from DEFAULT_SPAWN_POLICY so the ledger and policy limits stay in sync.
const DEFAULT_PROCESS_SPAWN_LEDGER = createInMemorySpawnLedger(
  DEFAULT_SPAWN_POLICY.maxTotalProcesses,
);

import type { DebugInstrumentation, RecomposedChains } from "@koi/engine-compose";
import {
  createDebugInstrumentation,
  recomposeChains,
  runSessionHooks,
  runTurnHooks,
  sortMiddlewareByPhase,
} from "@koi/engine-compose";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { collectDebugInfo } from "./debug/collect-debug-info.js";
import {
  createStubAdapter,
  createStubChannel,
  createStubMiddleware,
  PHASE1_MIDDLEWARE_NAMES,
} from "./stubs/index.js";
import { createAtifDocumentStore } from "./trajectory/atif-store.js";
import { createFsAtifDelegate } from "./trajectory/fs-delegate.js";
import type { RuntimeConfig, RuntimeHandle } from "./types.js";
import { DEFAULT_STREAM_TIMEOUT_MS } from "./types.js";

const DEFAULT_AGENT_NAME = "koi-runtime";

/**
 * Core factory: creates an assembled runtime from a configuration.
 *
 * Composition order:
 * 1. Resolve adapter, channel, middleware
 * 2. Create trajectory store (if trajectoryDir provided)
 * 3. Create debug instrumentation (if debug enabled)
 * 4. Compose middleware around adapter terminals with traceCallId injection
 * 5. Apply stream timeout enforcement
 * 6. Return RuntimeHandle with store exposed
 */
export function createRuntime(config: RuntimeConfig = {}): RuntimeHandle {
  const rawAdapter = resolveAdapter(config.adapter);
  const channel = resolveChannel(config.channel);
  const { middleware, stubInstances } = resolveMiddleware(config.middleware);
  const timeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  // Fail closed: if a real (non-stub) "permissions" middleware is installed
  // without an approval handler, the runtime cannot safely gate tool execution.
  const hasRealPermissions = middleware.some(
    (mw) => mw.name === "permissions" && !stubInstances.has(mw),
  );
  if (hasRealPermissions && config.requestApproval === undefined) {
    throw new Error(
      "Runtime has real permissions middleware but no requestApproval handler — " +
        "provide config.requestApproval or use a stub permissions middleware",
    );
  }

  // Create trajectory store if directory provided
  const trajectoryStore = resolveTrajectoryStore(config);

  // Create debug instrumentation when debug is enabled
  const instrumentation =
    config.debug === true ? createDebugInstrumentation({ enabled: true }) : undefined;

  // Compose middleware around adapter terminals, then apply timeout
  const composedAdapter = composeMiddlewareIntoAdapter(
    rawAdapter,
    middleware,
    instrumentation,
    trajectoryStore,
    config.requestApproval,
    config.userId,
    config.channelId,
    config.toolDescriptors,
  );
  const adapter = applyStreamTimeout(composedAdapter, timeoutMs);

  const debugInfo =
    config.debug === true
      ? collectDebugInfo(middleware, adapter, channel, stubInstances)
      : undefined;

  // Create spawn provider when a resolver is provided. Callers pass the provider
  // to createKoi({ providers: [handle.spawnProvider] }) to register the Spawn tool.
  // Resolve effective policy first so the fallback ledger uses the same capacity as
  // the policy — a custom spawnPolicy.maxTotalProcesses without an explicit ledger
  // would otherwise be silently ignored by the process-wide default ledger.
  const effectiveSpawnPolicy = config.spawnPolicy ?? DEFAULT_SPAWN_POLICY;
  const effectiveSpawnLedger =
    config.spawnLedger ??
    // Only reuse the shared default when the policy cap matches; otherwise allocate
    // a fresh ledger with the correct capacity so the configured limit is honoured.
    (effectiveSpawnPolicy.maxTotalProcesses === DEFAULT_SPAWN_POLICY.maxTotalProcesses
      ? DEFAULT_PROCESS_SPAWN_LEDGER
      : createInMemorySpawnLedger(effectiveSpawnPolicy.maxTotalProcesses));

  const spawnProvider =
    config.resolver !== undefined
      ? createSpawnToolProvider({
          resolver: config.resolver,
          spawnLedger: effectiveSpawnLedger,
          adapter,
          manifestTemplate: {
            name: "spawned-agent",
            version: "0.0.0",
            description: "Spawned sub-agent",
            model: { name: "sonnet" },
          },
          spawnPolicy: effectiveSpawnPolicy,
          ...(config.reportStore !== undefined ? { reportStore: config.reportStore } : {}),
        })
      : undefined;

  return {
    adapter,
    channel,
    middleware,
    debugInfo,
    trajectoryStore,
    spawnProvider,
    dispose: async () => {
      const results = await Promise.allSettled([
        channel.disconnect(),
        rawAdapter.dispose?.() ?? Promise.resolve(),
      ]);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length > 0) {
        throw new Error(
          `Runtime dispose failed: ${failures.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ")}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Component resolvers
// ---------------------------------------------------------------------------

function resolveAdapter(input: RuntimeConfig["adapter"]): EngineAdapter {
  if (input === undefined || input === "stub") {
    return createStubAdapter();
  }
  return input;
}

function resolveChannel(input: RuntimeConfig["channel"]): ChannelAdapter {
  if (input === undefined || input === "stub") {
    return createStubChannel();
  }
  return input;
}

function resolveMiddleware(provided: readonly KoiMiddleware[] | undefined): {
  readonly middleware: readonly KoiMiddleware[];
  readonly stubInstances: ReadonlySet<KoiMiddleware>;
} {
  const providedNames = new Set((provided ?? []).map((mw) => mw.name));
  const stubs: KoiMiddleware[] = [];

  for (const name of PHASE1_MIDDLEWARE_NAMES) {
    if (!providedNames.has(name)) {
      stubs.push(createStubMiddleware(name));
    }
  }

  return {
    middleware: [...(provided ?? []), ...stubs],
    stubInstances: new Set(stubs),
  };
}

function resolveTrajectoryStore(config: RuntimeConfig): TrajectoryDocumentStore | undefined {
  if (config.trajectoryDir === undefined) return undefined;
  const delegate = createFsAtifDelegate(config.trajectoryDir);
  const agentVersion = config.agentVersion;
  const storeConfig =
    agentVersion !== undefined
      ? { agentName: config.agentName ?? DEFAULT_AGENT_NAME, agentVersion }
      : { agentName: config.agentName ?? DEFAULT_AGENT_NAME };
  return createAtifDocumentStore(storeConfig, delegate);
}

// ---------------------------------------------------------------------------
// Middleware composition into adapter
// ---------------------------------------------------------------------------

interface MinimalContextOptions {
  readonly streamId?: string;
  readonly signal?: AbortSignal;
  readonly requestApproval?: ApprovalHandler;
  readonly userId?: string;
  readonly channelId?: string;
}

/**
 * Minimal TurnContext for the runtime scaffold.
 *
 * Limitations vs the full L1 engine context:
 * - No sendStatus (channel status updates are no-ops)
 * - No conversationId (set at conversation start by the full engine)
 *
 * requestApproval, userId, and channelId are now threaded from RuntimeConfig.
 */
function createMinimalTurnContext(options: MinimalContextOptions = {}): TurnContext {
  const id = options.streamId ?? "runtime";
  const sid = sessionId(id);
  const rid = runId(`${id}:r0`);
  return {
    session: {
      agentId: "runtime",
      sessionId: sid,
      runId: rid,
      metadata: {},
      ...(options.userId !== undefined ? { userId: options.userId } : {}),
      ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
    },
    turnIndex: 0,
    turnId: `${rid}:t0` as unknown as TurnId,
    messages: [],
    metadata: {},
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.requestApproval !== undefined ? { requestApproval: options.requestApproval } : {}),
  };
}

// ---------------------------------------------------------------------------
// Trajectory step buffer — collects steps synchronously, flushes in one write
// ---------------------------------------------------------------------------

/**
 * Collects RichTrajectorySteps synchronously during a stream's lifetime.
 * `flush()` writes all buffered steps in a single append (avoids read-modify-write races).
 */
interface StepBuffer {
  readonly push: (step: RichTrajectoryStep) => void;
  readonly flush: () => Promise<void>;
  /** Current step count (used as stepIndex for next step). */
  readonly size: () => number;
}

function createStepBuffer(store: TrajectoryDocumentStore, docId: string): StepBuffer {
  const steps: RichTrajectoryStep[] = [];
  return {
    push: (step: RichTrajectoryStep) => {
      steps.push(step);
    },
    flush: async () => {
      if (steps.length === 0) return;
      const batch = [...steps];
      steps.length = 0;
      await store.append(docId, batch);
    },
    size: () => steps.length,
  };
}

/**
 * Harness-level step: chain-level I/O (what went into/out of the middleware onion),
 * timing, traceCallId, outcome. This is NOT per-middleware I/O — it's the
 * before/after of the entire composed chain.
 *
 * Event-trace (#1274) captures the deeper LLM-level data: full prompt text,
 * reasoning content, tool definitions, token metrics from the provider.
 */
function createModelStep(
  stepIndex: number,
  traceCallId: string,
  request: ModelRequest,
  outcome: "success" | "failure",
  durationMs: number,
  responseContent?: string,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: Date.now(),
    source: "agent",
    kind: "model_call",
    identifier: request.model ?? "unknown",
    outcome,
    durationMs,
    request: {
      text: extractMessageText(request),
      data: { model: request.model, messageCount: request.messages.length } as JsonObject,
    },
    ...(responseContent !== undefined ? { response: { text: responseContent } } : {}),
    metadata: { traceCallId } as JsonObject,
  };
}

function createModelErrorStep(
  stepIndex: number,
  traceCallId: string,
  request: ModelRequest,
  error: unknown,
  durationMs: number,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: Date.now(),
    source: "agent",
    kind: "model_call",
    identifier: request.model ?? "unknown",
    outcome: "failure",
    durationMs,
    request: {
      text: extractMessageText(request),
      data: { model: request.model, messageCount: request.messages.length } as JsonObject,
    },
    error: { text: error instanceof Error ? error.message : String(error) },
    metadata: { traceCallId } as JsonObject,
  };
}

function createToolStep(
  stepIndex: number,
  traceCallId: string,
  request: ToolRequest,
  durationMs: number,
  responsePreview?: string,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: Date.now(),
    source: "tool",
    kind: "tool_call",
    identifier: request.toolId,
    outcome: "success",
    durationMs,
    request: {
      data: request.input,
      text: `${request.toolId}(${JSON.stringify(request.input).slice(0, 500)})`,
    },
    ...(responsePreview !== undefined ? { response: { text: responsePreview } } : {}),
    metadata: { traceCallId } as JsonObject,
  };
}

function createToolErrorStep(
  stepIndex: number,
  traceCallId: string,
  request: ToolRequest,
  error: unknown,
  durationMs: number,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: Date.now(),
    source: "tool",
    kind: "tool_call",
    identifier: request.toolId,
    outcome: "failure",
    durationMs,
    request: {
      data: request.input,
      text: `${request.toolId}(${JSON.stringify(request.input).slice(0, 500)})`,
    },
    error: { text: error instanceof Error ? error.message : String(error) },
    metadata: { traceCallId } as JsonObject,
  };
}

/** Max bytes for request text in trajectory steps. */
const MAX_REQUEST_TEXT_BYTES = 4096;

/**
 * Extracts human-readable text from a ModelRequest's messages.
 * Joins all text content blocks, truncates to MAX_REQUEST_TEXT_BYTES.
 */
function extractMessageText(request: ModelRequest): string {
  const parts: string[] = [];
  for (const msg of request.messages) {
    for (const block of msg.content) {
      if (block.kind === "text") {
        parts.push(block.text);
      }
    }
  }
  const full = parts.join("\n");
  if (full.length <= MAX_REQUEST_TEXT_BYTES) return full;
  return `${full.slice(0, MAX_REQUEST_TEXT_BYTES)}… [truncated]`;
}

function noop(): void {}

// ---------------------------------------------------------------------------
// Per-middleware I/O capture
// ---------------------------------------------------------------------------

/** Captured I/O for a single middleware hook invocation. */
interface MiddlewareIOCapture {
  readonly name: string;
  readonly hook: "wrapModelCall" | "wrapToolCall";
  readonly requestPreview: string;
  readonly responsePreview: string;
  /** traceCallId from the request metadata — used to scope captures per invocation. */
  readonly traceCallId?: string;
}

/**
 * Wraps a middleware to capture the request going in and response coming out
 * of each hook. The captured I/O is appended to the shared captures array.
 */
function wrapMiddlewareWithIOCapture(
  mw: KoiMiddleware,
  captures: MiddlewareIOCapture[],
): KoiMiddleware {
  const wrappedModelCall =
    mw.wrapModelCall !== undefined
      ? async (
          ctx: TurnContext,
          request: ModelRequest,
          next: (req: ModelRequest) => Promise<ModelResponse>,
        ): Promise<ModelResponse> => {
          const requestPreview = extractMessageText(request).slice(0, 500);
          // wrapModelCall is guaranteed defined by the outer `!== undefined` check
          const hook = mw.wrapModelCall;
          if (hook === undefined) return next(request);
          const response = await hook(ctx, request, next);
          const meta = request.metadata as Record<string, unknown> | undefined;
          const tid = typeof meta?.traceCallId === "string" ? meta.traceCallId : undefined;
          captures.push({
            name: mw.name,
            hook: "wrapModelCall",
            requestPreview,
            responsePreview: response.content.slice(0, 500),
            ...(tid !== undefined ? { traceCallId: tid } : {}),
          });
          return response;
        }
      : undefined;

  const wrappedToolCall =
    mw.wrapToolCall !== undefined
      ? async (
          ctx: TurnContext,
          request: ToolRequest,
          next: (req: ToolRequest) => Promise<ToolResponse>,
        ): Promise<ToolResponse> => {
          const requestPreview = `${request.toolId}(${JSON.stringify(request.input).slice(0, 200)})`;
          const hook = mw.wrapToolCall;
          if (hook === undefined) return next(request);
          const response = await hook(ctx, request, next);
          const outputStr =
            typeof response.output === "string" ? response.output : JSON.stringify(response.output);
          const meta = request.metadata as Record<string, unknown> | undefined;
          const tid = typeof meta?.traceCallId === "string" ? meta.traceCallId : undefined;
          captures.push({
            name: mw.name,
            hook: "wrapToolCall",
            requestPreview,
            responsePreview: outputStr.slice(0, 500),
            ...(tid !== undefined ? { traceCallId: tid } : {}),
          });
          return response;
        }
      : undefined;

  return {
    ...mw,
    ...(wrappedModelCall !== undefined ? { wrapModelCall: wrappedModelCall } : {}),
    ...(wrappedToolCall !== undefined ? { wrapToolCall: wrappedToolCall } : {}),
  };
}

// ---------------------------------------------------------------------------
// Middleware composition into adapter
// ---------------------------------------------------------------------------

/**
 * If the adapter exposes terminals, compose middleware onion chains around them
 * and inject composed callHandlers into every stream() call.
 *
 * Each model/tool call:
 * 1. Gets a traceCallId injected into request.metadata (for correlation)
 * 2. Has its input/output captured as a RichTrajectoryStep (when store exists)
 * 3. Runs through the full middleware onion chain
 */
function composeMiddlewareIntoAdapter(
  adapter: EngineAdapter,
  middleware: readonly KoiMiddleware[],
  instrumentation?: DebugInstrumentation,
  store?: TrajectoryDocumentStore,
  requestApproval?: ApprovalHandler,
  userId?: string,
  channelId?: string,
  toolDescriptors?: readonly ToolDescriptor[],
): EngineAdapter {
  if (adapter.terminals === undefined) {
    // Fail closed: if intercept-phase middleware is configured, refusing to silently
    // bypass it is a security requirement. Adapters without terminals cannot have
    // security middleware composed around them.
    const hasInterceptMiddleware = middleware.some((mw) => mw.phase === "intercept");
    if (hasInterceptMiddleware) {
      throw new Error(
        "Adapter has no terminals but intercept-phase middleware is configured. " +
          "Middleware would be silently bypassed. Either provide an adapter with terminals " +
          "or remove intercept-phase middleware.",
      );
    }
    return adapter;
  }

  const toolHandler = adapter.terminals.toolCall ?? defaultToolHandler;
  const modelStream = adapter.terminals.modelStream;

  const terminals =
    modelStream !== undefined
      ? { modelHandler: adapter.terminals.modelCall, modelStreamHandler: modelStream, toolHandler }
      : { modelHandler: adapter.terminals.modelCall, toolHandler };

  return {
    ...adapter,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      // Per-stream identity — each stream() call gets a unique session
      const streamId = crypto.randomUUID();
      const streamSignal = input.signal;
      const ctxOpts: MinimalContextOptions = { streamId };
      if (streamSignal !== undefined) (ctxOpts as Record<string, unknown>).signal = streamSignal;
      if (requestApproval !== undefined)
        (ctxOpts as Record<string, unknown>).requestApproval = requestApproval;
      if (userId !== undefined) (ctxOpts as Record<string, unknown>).userId = userId;
      if (channelId !== undefined) (ctxOpts as Record<string, unknown>).channelId = channelId;
      const ctx = createMinimalTurnContext(ctxOpts);
      const docId = `stream-${streamId}`;

      const buffer = store !== undefined ? createStepBuffer(store, docId) : undefined;

      // Per-stream event-trace: writes to the SAME store + docId as harness steps.
      // This unifies model/tool I/O (from event-trace) with middleware spans (from harness)
      // in one trajectory document.
      const perStreamEventTrace =
        store !== undefined
          ? createEventTraceMiddleware({ store, docId, agentName: "runtime" }).middleware
          : undefined;

      const perStreamMiddleware =
        perStreamEventTrace !== undefined ? [...middleware, perStreamEventTrace] : middleware;

      // Wrap middleware with I/O capture when debug + store are both enabled
      const ioCaptures: MiddlewareIOCapture[] = [];
      const wrappedMiddleware =
        store !== undefined && instrumentation !== undefined
          ? perStreamMiddleware.map((mw) => wrapMiddlewareWithIOCapture(mw, ioCaptures))
          : perStreamMiddleware;

      // Compose chains per-stream (includes per-stream event-trace)
      const sorted = sortMiddlewareByPhase(wrappedMiddleware);
      const chains: RecomposedChains = recomposeChains(sorted, terminals, instrumentation);
      const streamChain = chains.streamChain;
      // let: mutable turn counter — each call gets its own index eagerly
      let turnCounter = 0;

      /** Allocate a turn index for a new model/tool call. Must be called
       *  before the call starts so each invocation has its own index. */
      function allocateTurnIndex(): number {
        const index = turnCounter;
        turnCounter++;
        return index;
      }

      /** Create a context with the given turnIndex. */
      function ctxForTurn(turnIndex: number): TurnContext {
        return { ...ctx, turnIndex };
      }

      /** Collect DebugSpans + I/O captures and record as trajectory steps. */
      function recordSpans(traceCallId: string, turnIndex: number): void {
        if (buffer === undefined) return;

        // Extract I/O captures for THIS specific call (scoped by traceCallId)
        const capturedIO: MiddlewareIOCapture[] = [];
        for (let i = ioCaptures.length - 1; i >= 0; i--) {
          const c = ioCaptures[i];
          if (c !== undefined && (c.traceCallId === traceCallId || c.traceCallId === undefined)) {
            capturedIO.unshift(c);
            ioCaptures.splice(i, 1);
          }
        }

        if (instrumentation !== undefined) {
          instrumentation.onTurnEnd(turnIndex);
          const trace = instrumentation.getTrace(turnIndex);
          if (trace !== undefined) {
            for (const group of trace.spans) {
              const children = group.children ?? [];
              for (const span of children) {
                // Find matching I/O capture by middleware name + hook
                const io = capturedIO.find((c) => c.name === span.name && c.hook === group.name);
                buffer.push({
                  stepIndex: buffer.size(),
                  timestamp: trace.timestamp,
                  source: "system",
                  kind: "model_call",
                  identifier: `middleware:${span.name}`,
                  outcome: span.error !== undefined ? "failure" : "success",
                  durationMs: span.durationMs,
                  ...(io !== undefined
                    ? {
                        request: { text: io.requestPreview },
                        response: { text: io.responsePreview },
                      }
                    : {}),
                  metadata: {
                    type: "middleware_span",
                    traceCallId,
                    hook: group.name,
                    phase: span.phase,
                    priority: span.priority,
                    source: span.source,
                    nextCalled: span.nextCalled,
                    ...(span.error !== undefined ? { error: span.error } : {}),
                  } as JsonObject,
                });
              }
            }
            return;
          }
        }

        // Fallback: no instrumentation but we have I/O captures (store without debug)
        for (const io of capturedIO) {
          buffer.push({
            stepIndex: buffer.size(),
            timestamp: Date.now(),
            source: "system",
            kind: "model_call",
            identifier: `middleware:${io.name}`,
            outcome: "success",
            durationMs: 0,
            request: { text: io.requestPreview },
            response: { text: io.responsePreview },
            metadata: { type: "middleware_span", traceCallId, hook: io.hook } as JsonObject,
          });
        }
      }

      // Model call wrapper: traceCallId + signal + chain-level I/O + timing + spans
      const tracedModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        const traceCallId = crypto.randomUUID();
        const turnIndex = allocateTurnIndex();
        const enriched: ModelRequest = {
          ...request,
          metadata: { ...request.metadata, traceCallId },
          ...(streamSignal !== undefined ? { signal: streamSignal } : {}),
        };
        const start = performance.now();
        try {
          const response = await chains.modelChain(ctxForTurn(turnIndex), enriched);
          buffer?.push(
            createModelStep(
              buffer.size(),
              traceCallId,
              enriched,
              "success",
              performance.now() - start,
              response.content,
            ),
          );
          recordSpans(traceCallId, turnIndex);
          return response;
        } catch (error: unknown) {
          buffer?.push(
            createModelErrorStep(
              buffer.size(),
              traceCallId,
              enriched,
              error,
              performance.now() - start,
            ),
          );
          recordSpans(traceCallId, turnIndex);
          throw error;
        }
      };

      // Tool call wrapper: traceCallId + signal + chain-level I/O + timing + spans
      const tracedToolCall = async (request: ToolRequest): Promise<ToolResponse> => {
        const traceCallId = crypto.randomUUID();
        const turnIndex = allocateTurnIndex();
        const enriched: ToolRequest = {
          ...request,
          metadata: { ...request.metadata, traceCallId },
          ...(streamSignal !== undefined ? { signal: streamSignal } : {}),
        };
        const start = performance.now();
        try {
          const response = await chains.toolChain(ctxForTurn(turnIndex), enriched);
          const preview =
            typeof response.output === "string"
              ? response.output.slice(0, 200)
              : JSON.stringify(response.output).slice(0, 200);
          buffer?.push(
            createToolStep(
              buffer.size(),
              traceCallId,
              enriched,
              performance.now() - start,
              preview,
            ),
          );
          recordSpans(traceCallId, turnIndex);
          return response;
        } catch (error: unknown) {
          buffer?.push(
            createToolErrorStep(
              buffer.size(),
              traceCallId,
              enriched,
              error,
              performance.now() - start,
            ),
          );
          recordSpans(traceCallId, turnIndex);
          throw error;
        }
      };

      // Per-invocation stream call tracking (keyed by traceCallId).
      // Replaces single mutable slot — supports multi-call adapters.
      interface StreamCallRecord {
        readonly traceCallId: string;
        readonly request: ModelRequest;
        readonly start: number;
        readonly turnIndex: number;
        // let: mutable — updated as chunks flow
        content: string | undefined;
        completed: boolean;
        failed: boolean;
        errorMessage: string | undefined;
      }
      const pendingStreamCalls = new Map<string, StreamCallRecord>();

      const tracedModelStream =
        streamChain !== undefined
          ? (request: ModelRequest): AsyncIterable<ModelChunk> => {
              const traceCallId = crypto.randomUUID();
              const turnIndex = allocateTurnIndex();
              const enriched: ModelRequest = {
                ...request,
                metadata: { ...request.metadata, traceCallId },
                ...(streamSignal !== undefined ? { signal: streamSignal } : {}),
              };
              const record: StreamCallRecord = {
                traceCallId,
                request: enriched,
                start: performance.now(),
                content: undefined,
                completed: false,
                failed: false,
                errorMessage: undefined,
                turnIndex,
              };
              pendingStreamCalls.set(traceCallId, record);

              const inner = streamChain(ctxForTurn(turnIndex), enriched);
              return trackModelStreamContent(
                inner,
                (content) => {
                  record.content = content;
                  record.completed = true;
                  record.failed = false;
                },
                (error) => {
                  record.failed = true;
                  record.errorMessage = error instanceof Error ? error.message : String(error);
                },
              );
            }
          : undefined;

      const advertisedTools = toolDescriptors ?? [];
      const callHandlers: ComposedCallHandlers =
        tracedModelStream !== undefined
          ? {
              modelCall: tracedModelCall,
              modelStream: tracedModelStream,
              toolCall: tracedToolCall,
              tools: advertisedTools,
            }
          : { modelCall: tracedModelCall, toolCall: tracedToolCall, tools: advertisedTools };

      // Await session start so middleware state is initialized before the first call.
      // Wrapped in an async generator so the synchronous stream() method can return
      // immediately while initialization happens on the first next() call.
      const sessionStartPromise = runSessionHooks(sorted, "onSessionStart", ctx.session);

      const innerStream = adapter.stream(injectCallHandlers(input, callHandlers));
      const initializedStream = (async function* (): AsyncIterable<EngineEvent> {
        await sessionStartPromise;
        yield* innerStream;
      })();
      return wrapStreamWithFlush(
        initializedStream,
        buffer,
        () => {
          // Push ALL pending stream call steps before flush (supports multi-call adapters)
          if (buffer !== undefined) {
            for (const sc of pendingStreamCalls.values()) {
              if (sc.failed) {
                buffer.push(
                  createModelErrorStep(
                    buffer.size(),
                    sc.traceCallId,
                    sc.request,
                    sc.errorMessage ?? "Stream error",
                    performance.now() - sc.start,
                  ),
                );
              } else if (!sc.completed) {
                buffer.push(
                  createModelErrorStep(
                    buffer.size(),
                    sc.traceCallId,
                    sc.request,
                    "Stream abandoned before terminal chunk",
                    performance.now() - sc.start,
                  ),
                );
              } else {
                buffer.push(
                  createModelStep(
                    buffer.size(),
                    sc.traceCallId,
                    sc.request,
                    "success",
                    performance.now() - sc.start,
                    sc.content,
                  ),
                );
              }
              recordSpans(sc.traceCallId, sc.turnIndex);
            }
            pendingStreamCalls.clear();
          }
        },
        async () => {
          // Run lifecycle hooks on ALL middleware for session end
          await runTurnHooks(sorted, "onAfterTurn", ctx).catch(noop);
          await runSessionHooks(sorted, "onSessionEnd", ctx.session).catch(noop);
        },
      );
    },
  };
}

/**
 * Passthrough wrapper that captures done chunk content AND errors
 * for deferred trajectory step creation.
 */
async function* trackModelStreamContent(
  inner: AsyncIterable<ModelChunk>,
  onContent: (content: string | undefined) => void,
  onError: (error: unknown) => void,
): AsyncIterable<ModelChunk> {
  try {
    for await (const chunk of inner) {
      if (chunk.kind === "done") {
        onContent(chunk.response.content);
      }
      yield chunk;
    }
  } catch (error: unknown) {
    onError(error);
    throw error;
  }
}

/**
 * @deprecated Use trackModelStreamContent + deferred step in wrapStreamWithFlush.
 * Wraps a model stream to record a summary trajectory step after it completes.
 * Captures timing, outcome (success/failure based on done event), and the
 * response content from the terminal done chunk.
 */
async function* _wrapModelStreamWithTrace(
  inner: AsyncIterable<ModelChunk>,
  buffer: StepBuffer | undefined,
  traceCallId: string,
  request: ModelRequest,
): AsyncIterable<ModelChunk> {
  const start = performance.now();
  // let: mutable — tracks the last done chunk's content for the summary step
  let lastContent: string | undefined;
  // let: mutable — tracks whether the stream completed normally
  let failed = false;
  // let: mutable — tracks error message if stream fails
  let errorMessage: string | undefined;

  try {
    for await (const chunk of inner) {
      if (chunk.kind === "done") {
        lastContent = chunk.response.content;
      }
      yield chunk;
    }
  } catch (error: unknown) {
    failed = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (buffer !== undefined) {
      if (failed) {
        buffer.push(
          createModelErrorStep(
            buffer.size(),
            traceCallId,
            request,
            errorMessage ?? "Unknown stream error",
            performance.now() - start,
          ),
        );
      } else {
        buffer.push(
          createModelStep(
            buffer.size(),
            traceCallId,
            request,
            "success",
            performance.now() - start,
            lastContent,
          ),
        );
      }
    }
  }
}

/**
 * Wraps an async iterable to flush the step buffer after iteration completes.
 * Steps are collected synchronously during the stream, then written in one batch.
 */
async function* wrapStreamWithFlush(
  inner: AsyncIterable<EngineEvent>,
  buffer: StepBuffer | undefined,
  beforeFlush?: () => void,
  afterFlush?: () => Promise<void>,
): AsyncIterable<EngineEvent> {
  try {
    yield* inner;
  } finally {
    beforeFlush?.();
    await buffer?.flush().catch(noop);
    await afterFlush?.().catch(noop);
  }
}

/**
 * Default tool handler — throws a configuration error instead of returning
 * fake success. Any adapter loop that invokes callHandlers.toolCall will
 * surface the missing terminal as a runtime error.
 */
async function defaultToolHandler(): Promise<never> {
  throw new Error(
    "No toolCall terminal configured on adapter. " +
      "Tool execution requires an adapter with terminals.toolCall.",
  );
}

// ---------------------------------------------------------------------------
// Input injection helpers
// ---------------------------------------------------------------------------

function injectCallHandlers(input: EngineInput, callHandlers: ComposedCallHandlers): EngineInput {
  switch (input.kind) {
    case "text":
      return { ...input, callHandlers };
    case "messages":
      return { ...input, callHandlers };
    case "resume":
      return { ...input, callHandlers };
  }
}

function injectSignal(input: EngineInput, signal: AbortSignal): EngineInput {
  switch (input.kind) {
    case "text":
      return { ...input, signal };
    case "messages":
      return { ...input, signal };
    case "resume":
      return { ...input, signal };
  }
}

function applyStreamTimeout(adapter: EngineAdapter, timeoutMs: number): EngineAdapter {
  return {
    ...adapter,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const composedSignal =
        input.signal !== undefined ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      return adapter.stream(injectSignal(input, composedSignal));
    },
  };
}
