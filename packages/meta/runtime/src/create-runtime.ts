import { createAgentResolver } from "@koi/agent-runtime";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";
import { createSqliteAuditSink } from "@koi/audit-sink-sqlite";
import { type Checkpoint, createCheckpoint } from "@koi/checkpoint";
import type {
  ApprovalHandler,
  AuditSink,
  ChannelAdapter,
  ComponentProvider,
  ComposedCallHandlers,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  FileSystemBackend,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RetrySignalReader,
  RichTrajectoryStep,
  ToolDescriptor,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
  TurnId,
} from "@koi/core";
import { runId, sessionId } from "@koi/core";
import type { DecisionLedgerReader } from "@koi/decision-ledger";
import { createDecisionLedger } from "@koi/decision-ledger";
import { createInMemorySpawnLedger, createSpawnToolProvider } from "@koi/engine";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";
import { createLspComponentProvider } from "@koi/lsp";
import { createMemoryStore, type MemoryStore } from "@koi/memory-fs";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createBrowserProvider } from "@koi/tool-browser";

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
import { createEventTraceMiddleware, createMonotonicClock } from "@koi/event-trace";
import { createHttpTransport, type NexusTransport } from "@koi/fs-nexus";
import { createExfiltrationGuardMiddleware } from "@koi/middleware-exfiltration-guard";
import { createOtelMiddleware, type OtelMiddlewareConfig } from "@koi/middleware-otel";
import { createJsonlTranscript, createSessionTranscriptMiddleware } from "@koi/session";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCredentialPathGuard, type FsToolOptions } from "@koi/tools-builtin";
import {
  createFileSystemProvider,
  createFileSystemTools,
  createToolDispatcher,
} from "./create-filesystem-provider.js";
import { collectDebugInfo } from "./debug/collect-debug-info.js";
import { resolveFileSystem } from "./resolve-filesystem.js";
import {
  createStubAdapter,
  createStubChannel,
  createStubMiddleware,
  PHASE1_MIDDLEWARE_NAMES,
} from "./stubs/index.js";
import { createAtifDocumentStore } from "./trajectory/atif-store.js";
import { createFsAtifDelegate } from "./trajectory/fs-delegate.js";
import { createNexusAtifDelegate } from "./trajectory/nexus-delegate.js";
import { createNexusOutcomeDelegate } from "./trajectory/outcome-nexus-delegate.js";
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
  // Clock factory: creates a per-stream monotonic clock so concurrent sessions
  // don't push each other's timestamps into the future (see #1558).
  // When config.clock is provided, it's used as the base clock for each
  // per-stream monotonic wrapper — never shared directly across streams.
  const createClock = (): (() => number) => createMonotonicClock(config.clock);

  const rawAdapter = resolveAdapter(config.adapter);
  const channel = resolveChannel(config.channel);
  const { middleware: resolvedMiddleware, stubInstances } = resolveMiddleware(config.middleware);

  // Prepend session transcript middleware when transcriptDir is configured.
  // Observe-phase, priority 200 — runs after event-trace (priority 100) so
  // spans are already open when the transcript write occurs.
  //
  // The transcript instance is reused for the checkpoint package so /rewind
  // can call truncate() on the same conversation log the session middleware
  // appends to. Both halves of session rollback see the same source of truth.
  const sharedTranscript =
    config.session !== undefined
      ? createJsonlTranscript({ baseDir: config.session.transcriptDir })
      : undefined;
  const sessionTranscriptMw =
    sharedTranscript !== undefined
      ? createSessionTranscriptMiddleware({
          transcript: sharedTranscript,
          sessionId: sessionId("runtime"),
        })
      : undefined;

  // Resolve the filesystem backend EARLY so the checkpoint block can
  // borrow its path resolver. Without threading the backend's `resolvePath`
  // into checkpoint, callers that enable both `config.checkpoint` and
  // `config.filesystem: fs-local` silently get broken snapshots — the
  // backend writes to `<workspace-root>/src/foo.ts` while checkpoint hashes
  // blobs keyed on the raw tool-input path `/src/foo.ts`, so the restore
  // protocol no-ops on any file the tool actually wrote.
  const filesystemBackendForResolve = resolveFilesystemInput(config.filesystem, config.cwd);
  // Wrap the backend's method in an arrow so `this` stays bound to the
  // backend instance. Caller-provided class-backed backends may implement
  // resolvePath as a regular method that reads `this` (e.g., to access
  // the stored workspace root), and extracting it as a bare function
  // would lose the receiver — capturePreImage/capturePostImage would
  // then throw with `this is undefined` but only when checkpoint is
  // enabled, making the bug silent in every other config.
  const filesystemResolvePath: ((path: string) => string | undefined) | undefined =
    filesystemBackendForResolve?.resolvePath !== undefined
      ? (path: string) => filesystemBackendForResolve.resolvePath?.(path)
      : undefined;

  // Checkpoint (#1625) — wires capture middleware + CAS blob store, exposes
  // a programmatic rewind handle on the runtime. Optional: only constructed
  // when config.checkpoint is provided. Shares the SessionTranscript with
  // session middleware so /rewind truncates the conversation log alongside
  // the file-state restore. Threads the filesystem backend's `resolvePath`
  // so pre/post-image hashes are computed against the same on-disk paths
  // the backend writes to.
  const checkpointHandle: Checkpoint | undefined =
    config.checkpoint !== undefined
      ? createCheckpoint({
          store: createSnapshotStoreSqlite({
            path: config.checkpoint.snapshotPath ?? ":memory:",
          }),
          config: {
            blobDir: config.checkpoint.blobDir,
            // Drift detection runs git status on every turn. Disable for now —
            // the runtime doesn't know whether the cwd is a git repo and the
            // capture path should not require git availability. Callers who
            // want drift can pass a custom detector via createCheckpoint
            // directly (this runtime config is the simple shared default).
            driftDetector: null,
            ...(sharedTranscript !== undefined ? { transcript: sharedTranscript } : {}),
            ...(filesystemResolvePath !== undefined ? { resolvePath: filesystemResolvePath } : {}),
          },
        })
      : undefined;
  const checkpointMw = checkpointHandle?.middleware;

  // Audit middleware (@koi/middleware-audit). When config.audit is provided,
  // construct the selected sink and install the middleware in the observe phase.
  // Skipped if a middleware named "audit" is already supplied by the caller.
  // The returned handle is retained so dispose() can flush pending entries
  // and close runtime-owned sink resources.
  //
  // The handle is constructed NOW so it can be woven into `baseMiddleware`
  // in-order, but createRuntime has several fail-closed validations further
  // down (exfiltration-guard, permissions) that can throw synchronously.
  // Any throw between here and the final `return` would leak the runtime-
  // owned sink (open file/db handle, timer) — so every subsequent section
  // runs inside a try/catch that closes the handle on failure before
  // rethrowing. dispose() also calls close() on the success path.
  const hasAuditProvided = new Set(resolvedMiddleware.map((mw) => mw.name)).has("audit");
  const auditHandle: BuiltAudit | undefined =
    config.audit !== undefined && !hasAuditProvided
      ? buildAuditMiddleware(config.audit)
      : undefined;

  // Per-resource latches so repeated dispose() calls (the existing
  // retryable-shutdown pattern) do not re-close already-released runtime-
  // owned resources. If the first dispose() succeeds for audit/browser/lsp
  // but fails for some other leg (channel/adapter), the caller can retry —
  // and the retry must skip the already-closed resources.
  // let: flips to true once each owned resource has been released.
  let auditCleanedUp = false;
  let browserCleanedUp = false;
  let lspCleanedUp = false;

  try {
    const baseMiddleware: readonly KoiMiddleware[] = [
      ...(sessionTranscriptMw !== undefined ? [sessionTranscriptMw] : []),
      ...(checkpointMw !== undefined ? [checkpointMw] : []),
      ...(auditHandle !== undefined ? [auditHandle.middleware] : []),
      ...resolvedMiddleware,
    ];

    // Install exfiltration guard by default when: (1) not explicitly disabled,
    // (2) not already provided, and (3) the adapter has terminals so the intercept
    // phase won't be silently bypassed. Stub adapters have no terminals.
    const providedNames = new Set(baseMiddleware.map((mw) => mw.name));
    const exfiltrationRequested =
      config.exfiltrationGuard !== false && !providedNames.has("exfiltration-guard");
    const canInstallExfiltrationGuard = rawAdapter.terminals !== undefined;
    // Fail closed when the user explicitly requested the guard but the adapter can't support it.
    // The implicit default (config.exfiltrationGuard === undefined) on stub adapters is fine —
    // that's the normal test/default path and silently skips installation.
    if (
      exfiltrationRequested &&
      !canInstallExfiltrationGuard &&
      config.exfiltrationGuard !== undefined
    ) {
      throw new Error(
        "Exfiltration guard explicitly requested but adapter has no terminals — " +
          "intercept-phase middleware cannot be composed. Use an adapter with terminals " +
          "or pass exfiltrationGuard: false to disable.",
      );
    }
    const afterExfiltration: readonly KoiMiddleware[] =
      exfiltrationRequested && canInstallExfiltrationGuard
        ? [
            ...baseMiddleware,
            createExfiltrationGuardMiddleware(config.exfiltrationGuard ?? undefined),
          ]
        : baseMiddleware;

    // Append model-router as the innermost model-call interceptor (after exfiltration
    // guard and semantic-retry) so each retry attempt independently benefits from
    // provider failover. Skip when already provided in config.middleware by name.
    const hasModelRouter = new Set(afterExfiltration.map((mw) => mw.name)).has("model-router");
    const middleware: readonly KoiMiddleware[] =
      config.modelRouterMiddleware !== undefined && !hasModelRouter
        ? [...afterExfiltration, config.modelRouterMiddleware]
        : afterExfiltration;

    const timeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    // Filesystem: strict host opt-in only.
    // config.filesystem === false is a kill switch; undefined means no filesystem.
    // Manifest.filesystem exists in L0 for the full createKoi() assembly path
    // but is NOT honored here — createRuntime() requires explicit host config.
    //
    // Accepts either a FileSystemConfig (resolved here) or a pre-created
    // FileSystemBackend (used when the caller needs async setup, e.g. local
    // bridge transport with auth notification wiring via resolveFileSystemAsync).
    //
    // Reuse `filesystemBackendForResolve` from earlier — the checkpoint block
    // already needed the backend for its `resolvePath` method, so resolving
    // twice would be wasteful and could construct two independent backend
    // instances pointing at the same root.
    const filesystemBackend = filesystemBackendForResolve;
    // Extract operations from FileSystemConfig when present; fall back to
    // config.filesystemOperations for pre-created backends (e.g. from resolveFileSystemAsync).
    // Without this, pre-created backends default to read-only, silently dropping write/edit tools.
    const filesystemOperations =
      config.filesystem !== false &&
      config.filesystem !== undefined &&
      !isFileSystemBackend(config.filesystem)
        ? config.filesystem.operations
        : config.filesystemOperations;
    // Credential path guard: enabled by default, blocks access to ~/.ssh, ~/.aws, etc.
    // Constructed once and shared between the provider path and the dispatch path.
    const fsToolOptions: FsToolOptions | undefined =
      filesystemBackend !== undefined && config.credentialPathGuard !== false
        ? { pathGuard: createCredentialPathGuard() }
        : undefined;

    const filesystemProvider =
      filesystemBackend !== undefined
        ? createFileSystemProvider(filesystemBackend, "fs", filesystemOperations, fsToolOptions)
        : undefined;

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

    // Create trajectory store (filesystem or Nexus-backed)
    const trajectoryResolution = resolveTrajectoryStore(config);
    const trajectoryStore = trajectoryResolution?.store;
    const trajectoryTransport = trajectoryResolution?.transport;

    // Create outcome store when Nexus trajectory transport is available (#1465).
    // Shares the same transport. Scoped under the same namespace as trajectories
    // to preserve tenant isolation: {trajectoryBasePath}/outcomes/
    const trajectoryBasePath = config.trajectoryNexus?.basePath ?? "trajectories";
    const outcomeStore =
      trajectoryTransport !== undefined
        ? createNexusOutcomeDelegate({
            transport: trajectoryTransport,
            basePath: `${trajectoryBasePath}/outcomes`,
          })
        : undefined;

    // Track active stream flush promises so dispose() can drain before closing transport.
    const activeFlushes = new Set<Promise<void>>();
    // Track active stream finalizations (the full finally block, not just flush).
    // dispose() awaits these so transport is not closed under a stream still flushing.
    const activeStreamFinalizations = new Set<Promise<void>>();

    // Approval-step dispatch relay: routes onApprovalStep(sessionId, step) to the
    // correct per-stream EventTraceHandle.emitExternalStep by sessionId.
    const approvalDispatch = new Map<
      string,
      (sessionId: string, step: RichTrajectoryStep) => void
    >();
    const unsubApprovalSink =
      config.approvalStepHandle !== undefined
        ? config.approvalStepHandle.setApprovalStepSink(
            (sid: string, step: RichTrajectoryStep): void => {
              approvalDispatch.get(sid)?.(sid, step);
            },
          )
        : undefined;

    // Create debug instrumentation when debug is enabled
    const instrumentation =
      config.debug === true ? createDebugInstrumentation({ enabled: true }) : undefined;

    // Only advertise and wire fs tools when filesystem is explicitly enabled.
    // Host-provided tools take precedence — if a host already provides fs_read
    // (e.g., with custom sandboxing), the generated fs tool is excluded.
    const fsTools =
      filesystemBackend !== undefined
        ? createFileSystemTools(filesystemBackend, "fs", filesystemOperations, fsToolOptions)
        : undefined;
    const hostToolIds = new Set((config.toolDescriptors ?? []).map((d) => d.name));
    const dedupedFsDescriptors = (fsTools?.descriptors ?? []).filter(
      (d) => !hostToolIds.has(d.name),
    );
    const dedupedFsToolMap =
      fsTools !== undefined
        ? new Map([...fsTools.tools].filter(([name]) => !hostToolIds.has(name)))
        : undefined;
    const allToolDescriptors = [...dedupedFsDescriptors, ...(config.toolDescriptors ?? [])];

    // Inject filesystem tool handlers into the adapter's toolCall terminal.
    // Only inject when filesystem is enabled AND adapter has terminals.
    const adapterWithFsTools: EngineAdapter =
      dedupedFsToolMap !== undefined &&
      dedupedFsToolMap.size > 0 &&
      rawAdapter.terminals !== undefined
        ? {
            ...rawAdapter,
            terminals: {
              ...rawAdapter.terminals,
              toolCall: createToolDispatcher(dedupedFsToolMap, rawAdapter.terminals.toolCall),
            },
          }
        : rawAdapter;

    // Resolve OTel config: `true` uses all defaults, object passes config through, falsy disables.
    const otelConfig: OtelMiddlewareConfig | undefined =
      config.otel === true
        ? {}
        : config.otel !== undefined && config.otel !== false
          ? config.otel
          : undefined;

    // Compose middleware around adapter terminals, then apply timeout
    const composedAdapter = composeMiddlewareIntoAdapter(
      adapterWithFsTools,
      middleware,
      instrumentation,
      trajectoryStore,
      approvalDispatch,
      config.requestApproval,
      config.userId,
      config.channelId,
      allToolDescriptors,
      config.retrySignalReader,
      config.agentName ?? DEFAULT_AGENT_NAME,
      createClock,
      config.onTrajectoryFlushError,
      activeFlushes,
      activeStreamFinalizations,
      otelConfig,
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

    // Resolve the effective agent resolver: explicit > agentDirs shortcut > none.
    // Collect warnings/conflicts so they can be returned on RuntimeHandle for caller inspection.
    let agentWarnings: import("@koi/agent-runtime").AgentLoadWarning[] = [];
    let agentConflicts: import("@koi/agent-runtime").RegistryConflictWarning[] = [];
    const effectiveResolver = (() => {
      if (config.resolver !== undefined) return config.resolver;
      if (config.agentDirs !== undefined) {
        const result = createAgentResolver(config.agentDirs);
        agentWarnings = [...result.warnings];
        agentConflicts = [...result.conflicts];
        for (const w of agentWarnings) {
          console.warn(`[koi/runtime] agent load warning: ${w.error.message} (${w.filePath})`);
        }
        for (const c of agentConflicts) {
          console.warn(
            `[koi/runtime] agent conflict: "${c.agentType}" defined in multiple files — using first`,
          );
        }
        return result.resolver;
      }
      return undefined;
    })();

    // Resolver already returns NOT_FOUND for poisoned agent types (parse failures block
    // both the custom and built-in slots via failedTypes). Healthy agent types remain
    // reachable regardless of warnings. Suppressing the entire provider on any warning
    // would be over-broad: one bad custom-only file would disable all built-in delegation.
    // Callers should inspect handle.agentWarnings and fail or log at their policy boundary.
    const spawnProvider =
      effectiveResolver !== undefined
        ? createSpawnToolProvider({
            resolver: effectiveResolver,
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

    // Browser tool provider (@koi/tool-browser) — construct a ComponentProvider
    // from a caller-supplied BrowserDriver.
    //
    // Ownership: `backend` must be unshared per runtime (enforced by docs on
    // RuntimeConfig.browser). The inner provider disposes the backend on its
    // ref-count → 0 transition during createKoi detach. If the caller never
    // goes through that path (error/abort, or runtime created but never
    // wired into createKoi), the runtime owns cleanup and invokes
    // `backend.dispose?.()` from `runtime.dispose()` — guarded by an
    // attach/detach counter mirror so a completed createKoi lifecycle does
    // not cause a double-dispose. Counters only advance after the inner
    // call resolves so a single-agent attach rejection cannot falsely mark
    // the provider as attached, and detach uses a finally block so a
    // partial-detach rejection still records the attempt (the inner
    // provider has already decremented its own refcount at that point).
    // let: runtime-side mirror of inner provider's ref-count.
    let browserAttachCount = 0;
    let browserDetachCount = 0;
    const browserBackend = config.browser?.backend;
    const browserProvider: ComponentProvider | undefined = (() => {
      if (config.browser === undefined) return undefined;
      const inner = createBrowserProvider({
        backend: config.browser.backend,
        ...(config.browser.operations !== undefined
          ? { operations: config.browser.operations }
          : {}),
        ...(config.browser.prefix !== undefined ? { prefix: config.browser.prefix } : {}),
        ...(config.browser.policy !== undefined ? { policy: config.browser.policy } : {}),
        ...(config.browser.isUrlAllowed !== undefined
          ? { isUrlAllowed: config.browser.isUrlAllowed }
          : {}),
      });
      const innerAttach = inner.attach;
      const innerDetach = inner.detach;
      return {
        ...inner,
        attach: async (agent) => {
          if (innerAttach === undefined) {
            browserAttachCount += 1;
            return new Map();
          }
          const result = await innerAttach.call(inner, agent);
          browserAttachCount += 1;
          return result;
        },
        detach: async (agent) => {
          // Advance only after success. If inner detach throws partway,
          // some resources may already be released and some may not;
          // leaving the counter low lets runtime.dispose() run a
          // best-effort fallback for whatever is still live. The inner
          // provider's detach is the single source of truth, not the
          // runtime mirror.
          if (innerDetach !== undefined) {
            await innerDetach.call(inner, agent);
          }
          browserDetachCount += 1;
        },
      };
    })();

    // LSP tool provider (@koi/lsp) — lazy: LSP startup spawns language-server
    // subprocesses and negotiates capabilities over JSON-RPC. Starting those
    // eagerly in createRuntime() (a sync factory) means a runtime that is
    // created and disposed before the caller ever wants LSP tools would still
    // leave subprocess/fd leaks outliving dispose().
    //
    // Instead expose a thunk the caller invokes on demand. First call spawns
    // servers and caches the promise; subsequent calls share it. dispose()
    // inspects the cache — if LSP was never requested, nothing to clean up.
    //
    // Lifecycle bookkeeping: the underlying LSP provider is ref-counted; its
    // pool.release()/client.close() path only runs when the refcount hits
    // zero. A single boolean "detach ran once" is not enough — if the caller
    // attaches twice and only detaches once, the provider is still holding
    // clients, so dispose() must step in. Mirror the provider's ref-count
    // on the runtime side (attach/detach counters) and only treat cleanup
    // as "already done" when detachCount >= attachCount && attachCount > 0.
    const lspConfig = config.lsp;
    // let: cache for the lazily-started provider promise. Assigned on first
    // call to `lspProvider()` so dispose() can observe whether LSP started.
    let lspProviderCache:
      | Promise<{
          readonly provider: ComponentProvider;
          readonly clients: readonly import("@koi/lsp").LspClient[];
          readonly failures: readonly import("@koi/lsp").LspServerFailure[];
        }>
      | undefined;
    // let: ref-count mirror so dispose() can tell whether the inner provider
    // has released its clients (attachCount > 0 && detachCount >= attachCount).
    let lspAttachCount = 0;
    let lspDetachCount = 0;
    const lspProvider =
      lspConfig !== undefined
        ? () => {
            if (lspProviderCache === undefined) {
              lspProviderCache = createLspComponentProvider(lspConfig).then((inner) => {
                // Wrap attach/detach to mirror the provider's ref-count. Only
                // increment after the inner call succeeds — the tool-browser /
                // LSP single-agent guard throws on duplicate attach, and
                // counting a failed attach as a live attachment would make
                // dispose() run cleanup twice.
                const innerAttach = inner.provider.attach;
                const innerDetach = inner.provider.detach;
                const wrapped: ComponentProvider = {
                  ...inner.provider,
                  attach: async (agent) => {
                    if (innerAttach === undefined) {
                      lspAttachCount += 1;
                      return new Map();
                    }
                    const result = await innerAttach.call(inner.provider, agent);
                    lspAttachCount += 1;
                    return result;
                  },
                  detach: async (agent) => {
                    // Advance only after success. A partial detach failure
                    // leaves the counter low so runtime.dispose() runs a
                    // best-effort fallback against whatever is still live.
                    // Double-release risk against the part that WAS
                    // released is the lesser hazard — the pool's
                    // release() is trivially idempotent (set-key
                    // overwrite) and LspClient.close() is safe to call
                    // twice.
                    if (innerDetach !== undefined) {
                      await innerDetach.call(inner.provider, agent);
                    }
                    lspDetachCount += 1;
                  },
                };
                return { ...inner, provider: wrapped };
              });
            }
            return lspProviderCache;
          }
        : undefined;

    // File-based memory store (@koi/memory-fs) — exposed as-is on the handle.
    // A MemoryToolBackend adapter for @koi/memory-tools is tracked as follow-up.
    const memoryStore: MemoryStore | undefined =
      config.memoryFs !== undefined ? createMemoryStore(config.memoryFs) : undefined;

    // Decision-ledger factory — present only when the runtime has a
    // trajectoryStore to anchor the join. The returned reader wires
    // the live trajectoryStore plus the runtime's configured reportStore
    // (if any). Incident tooling can pass overrides to inject ad-hoc
    // audit or report sinks without rebuilding the runtime.
    const decisionLedgerFactory =
      trajectoryStore !== undefined
        ? (
            overrides?: Parameters<NonNullable<RuntimeHandle["createDecisionLedger"]>>[0],
          ): DecisionLedgerReader => {
            const auditSink = overrides?.auditSink;
            const reportStore = overrides?.reportStore ?? config.reportStore;
            return createDecisionLedger({
              trajectoryStore,
              ...(auditSink !== undefined ? { auditSink } : {}),
              ...(reportStore !== undefined ? { reportStore } : {}),
            });
          }
        : undefined;

    return {
      adapter,
      channel,
      middleware,
      debugInfo,
      trajectoryStore,
      outcomeStore,
      spawnProvider,
      agentWarnings,
      agentConflicts,
      checkpoint: checkpointHandle,
      filesystemBackend,
      filesystemProvider,
      browserProvider,
      lspProvider,
      memoryStore,
      createDecisionLedger: decisionLedgerFactory,
      dispose: async () => {
        // Unsubscribe approval sink to prevent leak on long-lived permission handles
        unsubApprovalSink?.();
        // Step 1: Dispose adapter first — this terminates active model streams,
        // which triggers their finally blocks (where flush + afterFlush run).
        // Without this, awaiting stream finalizations would deadlock because
        // only adapter disposal can abort a live model stream.
        const results = await Promise.allSettled([
          channel.disconnect(),
          rawAdapter.dispose?.() ?? Promise.resolve(),
          filesystemBackend?.dispose?.() ?? Promise.resolve(),
        ]);
        // Step 2: Drain stream finalizations (flush + afterFlush) with a bounded
        // timeout. Adapters without dispose() or that don't cancel streams would
        // cause an indefinite hang without this bound. 5s is generous for I/O.
        const DRAIN_TIMEOUT_MS = 5000;
        const drainWithTimeout = (promises: Set<Promise<void>>): Promise<unknown> => {
          if (promises.size === 0) return Promise.resolve();
          return Promise.race([
            Promise.allSettled([...promises]),
            new Promise<void>((r) => setTimeout(r, DRAIN_TIMEOUT_MS)),
          ]);
        };
        await drainWithTimeout(activeStreamFinalizations);
        await drainWithTimeout(activeFlushes);
        // Step 3: Close trajectory Nexus transport AFTER all flushes complete.
        trajectoryTransport?.close();
        // Step 4: Release runtime-owned L2 resources wired from config.
        //
        // LSP: startup is lazy — `lspProvider()` is a thunk that only spawns
        // servers on first call. If the caller never invoked it, there is
        // nothing to clean up (the cache is still undefined). If they did,
        // dispose awaits the cached startup promise to COMPLETION before
        // releasing clients. The inner LSP client enforces its own
        // `connectTimeoutMs` (default 30s) plus retry budget, so this
        // settles in bounded time and produces a deterministic list of
        // clients to close/release. Racing a separate timeout here would
        // leave a resolved-but-orphaned promise that spawns subprocesses
        // no one ever closes.
        //
        // When `config.lsp.pool` is set, pool-acquired (and freshly-created
        // fallback) clients are released back to the pool; otherwise they are
        // closed directly. If the inner provider.detach already ran
        // (lspDetachCount >= lspAttachCount && lspAttachCount > 0), cleanup
        // has already happened and dispose must skip to avoid double-release.
        //
        // Audit: when the runtime constructed the sink from a discriminated-
        // union config, it also owns the file/db handles and timer. Flush the
        // middleware queue first so queued entries hit the sink, then close.
        const lspPool = lspConfig?.pool;
        const extraShutdown = await Promise.allSettled([
          lspProviderCache !== undefined && !lspCleanedUp
            ? (async () => {
                // Startup errors surface to the caller via handle.lspProvider();
                // dispose just needs to release whatever did start successfully.
                const settled = await lspProviderCache.then(
                  (r) => ({ ok: true as const, result: r }),
                  () => ({ ok: false as const }),
                );
                if (!settled.ok) return;
                const cleanupDone = lspAttachCount > 0 && lspDetachCount >= lspAttachCount;
                if (cleanupDone) {
                  lspCleanedUp = true;
                  return;
                }
                if (lspPool !== undefined) {
                  // Fail closed: if pool.release throws (pool closed, unknown
                  // client, misbehaving impl) fall back to close() so the
                  // client process does not silently leak. Propagate the
                  // underlying error via Promise.reject so the aggregated
                  // dispose failure surfaces it instead of swallowing it.
                  const releaseResults = await Promise.allSettled(
                    settled.result.clients.map(async (client) => {
                      try {
                        lspPool.release(client.serverName(), client);
                      } catch (releaseErr) {
                        try {
                          await client.close();
                        } catch (closeErr) {
                          throw new Error(
                            `LSP pool release failed and fallback close also failed: ${String(releaseErr)}; ${String(closeErr)}`,
                          );
                        }
                        throw releaseErr instanceof Error
                          ? releaseErr
                          : new Error(String(releaseErr));
                      }
                    }),
                  );
                  const failed = releaseResults.filter(
                    (r): r is PromiseRejectedResult => r.status === "rejected",
                  );
                  if (failed.length > 0) {
                    throw new Error(
                      `LSP pool release failures: ${failed.map((f) => String(f.reason)).join("; ")}`,
                    );
                  }
                  lspCleanedUp = true;
                  return;
                }
                // Non-pool path: collect and surface any close() failures so
                // orphaned language-server processes do not hide behind a
                // green shutdown. Mirrors the pool-release branch.
                const closeResults = await Promise.allSettled(
                  settled.result.clients.map((c) => c.close()),
                );
                const closeFailed = closeResults.filter(
                  (r): r is PromiseRejectedResult => r.status === "rejected",
                );
                if (closeFailed.length > 0) {
                  throw new Error(
                    `LSP client close failures: ${closeFailed.map((f) => String(f.reason)).join("; ")}`,
                  );
                }
                lspCleanedUp = true;
              })()
            : Promise.resolve(),
          auditHandle !== undefined && !auditCleanedUp
            ? (async () => {
                await auditHandle.close();
                auditCleanedUp = true;
              })()
            : Promise.resolve(),
          // Browser backend: fall back to backend.dispose() when the
          // inner provider has not fully detached. The unshared-per-
          // runtime contract makes this safe — no other consumer can be
          // holding the same BrowserDriver. The counter guard prevents
          // double dispose when createKoi already released it, and the
          // latch prevents repeated dispose() from re-calling dispose().
          browserBackend !== undefined &&
          !browserCleanedUp &&
          !(browserAttachCount > 0 && browserDetachCount >= browserAttachCount) &&
          browserBackend.dispose !== undefined
            ? (async () => {
                await browserBackend.dispose?.();
                browserCleanedUp = true;
              })()
            : Promise.resolve(),
        ]);
        const allFailures = [
          ...results.filter((r): r is PromiseRejectedResult => r.status === "rejected"),
          ...extraShutdown.filter((r): r is PromiseRejectedResult => r.status === "rejected"),
        ];
        if (allFailures.length > 0) {
          throw new Error(
            `Runtime dispose failed: ${allFailures.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ")}`,
          );
        }
      },
    };
  } catch (err) {
    // Close runtime-owned resources before rethrowing so a constructor-time
    // throw cannot leak file/db handles, timers, or browser subprocesses.
    // Fire-and-forget because createRuntime is sync; swallow any close error
    // since the original throw is what the caller cares about.
    if (auditHandle !== undefined) {
      auditHandle.close().catch(() => {
        // best-effort cleanup during createRuntime error path
      });
    }
    // Browser backend: unshared-per-runtime contract means nothing else
    // holds the driver, so disposing here cannot interfere with peers.
    // The caller never receives a RuntimeHandle so runtime.dispose() will
    // never run — this is the only chance to release the backend.
    if (config.browser?.backend?.dispose !== undefined) {
      try {
        const result = config.browser.backend.dispose();
        if (result instanceof Promise) {
          result.catch(() => {
            // best-effort cleanup during createRuntime error path
          });
        }
      } catch {
        // best-effort cleanup during createRuntime error path
      }
    }
    throw err;
  }
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

/**
 * Result of constructing audit middleware — middleware plus a close callback
 * that dispose() calls to flush pending entries and release runtime-owned
 * sink resources (file/db handles, timers). When the caller passes in their
 * own `AuditSink` instance, the close callback only flushes the middleware —
 * sink lifecycle stays with the caller.
 */
interface BuiltAudit {
  readonly middleware: KoiMiddleware;
  readonly close: () => Promise<void>;
}

/**
 * Construct audit middleware from `RuntimeConfig.audit`. The sink is either
 * pre-built (pass-through, caller-owned) or resolved here from a
 * discriminated-union config via `@koi/audit-sink-ndjson` /
 * `@koi/audit-sink-sqlite` (runtime-owned, closed in dispose()).
 */
/**
 * Test whether the caller passed a pre-built `AuditSink` (which must expose
 * a `log` function per the L0 contract) vs a config object for the
 * discriminated union. Testing for `log` is nominal: config objects have no
 * runtime behavior, only data. This prevents a caller sink that happens to
 * carry `{ kind: "ndjson", filePath: ... }` as metadata from being
 * misclassified as a config and replaced with a fresh file sink.
 */
function isAuditSink(v: object): v is AuditSink {
  return typeof (v as { readonly log?: unknown }).log === "function";
}

function buildAuditMiddleware(audit: NonNullable<RuntimeConfig["audit"]>): BuiltAudit {
  const sinkInput = audit.sink;
  // Closer for runtime-owned sinks only; undefined when caller supplies an AuditSink.
  let ownedSinkClose: (() => Promise<void>) | undefined;
  let sink: AuditSink;

  if (isAuditSink(sinkInput)) {
    sink = sinkInput;
  } else if (sinkInput.kind === "ndjson") {
    const built = createNdjsonAuditSink({
      filePath: sinkInput.filePath,
      ...(sinkInput.flushIntervalMs !== undefined
        ? { flushIntervalMs: sinkInput.flushIntervalMs }
        : {}),
    });
    sink = built;
    ownedSinkClose = async () => {
      await built.close();
    };
  } else if (sinkInput.kind === "sqlite") {
    const built = createSqliteAuditSink({
      dbPath: sinkInput.dbPath,
      ...(sinkInput.flushIntervalMs !== undefined
        ? { flushIntervalMs: sinkInput.flushIntervalMs }
        : {}),
      ...(sinkInput.maxBufferSize !== undefined ? { maxBufferSize: sinkInput.maxBufferSize } : {}),
    });
    sink = built;
    ownedSinkClose = async () => {
      built.close();
    };
  } else {
    throw new Error(
      `Unsupported audit sink config: expected AuditSink with log(), or { kind: "ndjson" | "sqlite" }`,
    );
  }

  const mw = createAuditMiddleware({
    sink,
    ...(audit.maxQueueDepth !== undefined ? { maxQueueDepth: audit.maxQueueDepth } : {}),
    ...(audit.signing !== undefined ? { signing: audit.signing } : {}),
    ...(audit.redactRequestBodies !== undefined
      ? { redactRequestBodies: audit.redactRequestBodies }
      : {}),
  });

  return {
    middleware: mw,
    close: async () => {
      // Best-effort: drain queued entries first, but ALWAYS release the
      // runtime-owned sink resources (file/db handle, timer) — even if
      // flush rejects due to an I/O or DB error. Otherwise a failing
      // flush would leak the underlying descriptor on repeated
      // startup/shutdown attempts. If both throw, aggregate.
      let flushErr: unknown;
      try {
        await mw.flush();
      } catch (err) {
        flushErr = err;
      }
      let closeErr: unknown;
      if (ownedSinkClose !== undefined) {
        try {
          await ownedSinkClose();
        } catch (err) {
          closeErr = err;
        }
      }
      if (flushErr !== undefined && closeErr !== undefined) {
        throw new Error(
          `Audit flush and sink close both failed: ${String(flushErr)}; ${String(closeErr)}`,
        );
      }
      if (flushErr !== undefined) throw flushErr;
      if (closeErr !== undefined) throw closeErr;
    },
  };
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

interface TrajectoryResolution {
  readonly store: TrajectoryDocumentStore;
  /** Nexus transport to close on dispose. Undefined for filesystem delegate. */
  readonly transport?: NexusTransport | undefined;
}

function resolveTrajectoryStore(config: RuntimeConfig): TrajectoryResolution | undefined {
  if (config.trajectoryDir !== undefined && config.trajectoryNexus !== undefined) {
    throw new Error(
      "Cannot provide both trajectoryDir and trajectoryNexus — pick one trajectory backend",
    );
  }

  const agentVersion = config.agentVersion;
  const storeConfig =
    agentVersion !== undefined
      ? { agentName: config.agentName ?? DEFAULT_AGENT_NAME, agentVersion }
      : { agentName: config.agentName ?? DEFAULT_AGENT_NAME };

  if (config.trajectoryNexus !== undefined) {
    const { apiKey } = config.trajectoryNexus;
    const rawUrl = config.trajectoryNexus.url;
    if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
      throw new Error("trajectoryNexus.url must be a non-empty string");
    }
    const url = rawUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`trajectoryNexus.url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`trajectoryNexus.url must use http:// or https:// (got ${parsed.protocol})`);
    }
    const transport = createHttpTransport({ url, apiKey });
    const delegate = createNexusAtifDelegate({
      transport,
      basePath: config.trajectoryNexus.basePath,
    });
    return { store: createAtifDocumentStore(storeConfig, delegate), transport };
  }

  if (config.trajectoryDir !== undefined) {
    const delegate = createFsAtifDelegate(config.trajectoryDir);
    return { store: createAtifDocumentStore(storeConfig, delegate) };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Middleware composition into adapter
// ---------------------------------------------------------------------------

interface MinimalContextOptions {
  readonly streamId?: string;
  /**
   * Fixed session ID for TurnContext.session.sessionId. When provided, all
   * streams share the same session ID so middleware (e.g. transcript) can
   * route writes to a single persistent file across multi-turn sessions.
   * When omitted, defaults to streamId (unique per stream).
   */
  readonly sessionId?: string;
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
  // Use explicit sessionId override when provided so multi-turn sessions share
  // a single routing key (e.g., for transcript middleware). ATIF docId still
  // uses streamId (unique per stream) to keep trajectory documents separate.
  const sid = sessionId(options.sessionId ?? id);
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
      // Clear before write (at-most-once): prevents duplicate steps on ambiguous
      // transport failures where the remote write committed but the ack was lost.
      // Worst case: one batch of steps lost on a rare transport failure.
      // This is safer than at-least-once (duplicate steps corrupt trajectories).
      // Phase 2 OCC (#1469) will enable exactly-once via etag/if_match.
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
  stepClock: () => number = Date.now,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: stepClock(),
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
  stepClock: () => number = Date.now,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: stepClock(),
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
  stepClock: () => number = Date.now,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: stepClock(),
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
  stepClock: () => number = Date.now,
): RichTrajectoryStep {
  return {
    stepIndex,
    timestamp: stepClock(),
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
  approvalDispatch?: Map<string, (sessionId: string, step: RichTrajectoryStep) => void>,
  requestApproval?: ApprovalHandler,
  userId?: string,
  channelId?: string,
  toolDescriptors?: readonly ToolDescriptor[],
  retrySignalReader?: RetrySignalReader,
  agentName?: string,
  createClock: () => () => number = () => Date.now,
  onFlushError?: (error: unknown) => void,
  flushTracker?: Set<Promise<void>>,
  streamFinalizationTracker?: Set<Promise<void>>,
  otelConfig?: OtelMiddlewareConfig,
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
      const ctxOpts: MinimalContextOptions = {
        streamId,
      };
      if (streamSignal !== undefined) (ctxOpts as Record<string, unknown>).signal = streamSignal;
      if (requestApproval !== undefined)
        (ctxOpts as Record<string, unknown>).requestApproval = requestApproval;
      if (userId !== undefined) (ctxOpts as Record<string, unknown>).userId = userId;
      if (channelId !== undefined) (ctxOpts as Record<string, unknown>).channelId = channelId;
      const ctx = createMinimalTurnContext(ctxOpts);
      const docId = `stream-${streamId}`;

      const buffer = store !== undefined ? createStepBuffer(store, docId) : undefined;
      // Per-stream monotonic clock — scoped to this session so concurrent
      // sessions don't interfere with each other's timestamp sequences.
      const clock = createClock();

      // Per-stream event-trace: writes to the SAME store + docId as harness steps.
      // This unifies model/tool I/O (from event-trace) with middleware spans (from harness)
      // in one trajectory document.
      // Per-stream OTel handle — created once per stream so session span
      // lifetime (onSessionStart → onSessionEnd) maps 1:1 to the stream.
      const otelHandle = otelConfig !== undefined ? createOtelMiddleware(otelConfig) : undefined;

      const eventTraceHandle =
        store !== undefined
          ? createEventTraceMiddleware({
              store,
              docId,
              agentName: agentName ?? "runtime",
              clock,
              ...(retrySignalReader !== undefined ? { signalReader: retrySignalReader } : {}),
              ...(otelHandle !== undefined ? { onStep: otelHandle.onStep } : {}),
            })
          : undefined;

      // Register per-stream emitter for approval trajectory capture.
      // The dispatch relay (wired above) routes onApprovalStep by sessionId
      // to the correct per-stream emitExternalStep.
      const sid = ctx.session.sessionId as string;
      if (eventTraceHandle !== undefined && approvalDispatch !== undefined) {
        approvalDispatch.set(sid, eventTraceHandle.emitExternalStep);
      }

      const perStreamMiddleware = [
        ...middleware,
        ...(eventTraceHandle !== undefined ? [eventTraceHandle.middleware] : []),
        ...(otelHandle !== undefined ? [otelHandle.middleware] : []),
      ];

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
            timestamp: clock(),
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
              clock,
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
              clock,
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
              clock,
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
              clock,
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
                    clock,
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
                    clock,
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
                    clock,
                  ),
                );
              }
              recordSpans(sc.traceCallId, sc.turnIndex);
            }
            pendingStreamCalls.clear();
          }
        },
        async () => {
          // Deregister per-stream approval dispatch entry
          approvalDispatch?.delete(sid);
          // Run lifecycle hooks on ALL middleware for session end
          await runTurnHooks(sorted, "onAfterTurn", ctx).catch(noop);
          await runSessionHooks(sorted, "onSessionEnd", ctx.session).catch(noop);
        },
        onFlushError,
        flushTracker,
        streamFinalizationTracker,
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
  stepClock: () => number = Date.now,
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
            stepClock,
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
            stepClock,
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
  onFlushError?: (error: unknown) => void,
  flushTracker?: Set<Promise<void>>,
  streamFinalizationTracker?: Set<Promise<void>>,
): AsyncIterable<EngineEvent> {
  // Deferred resolve: the finalization promise is created immediately and tracked
  // so dispose() can await it even if the stream hasn't reached its finally block yet.
  // let: mutable — set once by the finally block's deferred executor.
  let resolveFinalization: (() => void) | undefined;
  const finalizationPromise = new Promise<void>((r) => {
    resolveFinalization = r;
  });
  streamFinalizationTracker?.add(finalizationPromise);

  try {
    yield* inner;
  } finally {
    try {
      beforeFlush?.();
      // Surface trajectory flush failures so remote persistence errors are observable.
      // Prior to Nexus backends this was always in-memory and couldn't fail meaningfully.
      // Cleanup (flushTracker removal + afterFlush) is unconditional via try/finally
      // so a throwing onFlushError callback cannot leak per-session state.
      const flushPromise = (async () => {
        try {
          await buffer?.flush();
        } catch (e: unknown) {
          if (onFlushError !== undefined) {
            onFlushError(e);
          } else {
            console.error("[koi:runtime] trajectory flush failed:", e);
          }
        }
      })();
      flushTracker?.add(flushPromise);
      try {
        await flushPromise;
      } finally {
        flushTracker?.delete(flushPromise);
        await afterFlush?.().catch(noop);
      }
    } finally {
      streamFinalizationTracker?.delete(finalizationPromise);
      resolveFinalization?.();
    }
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

/**
 * Type guard: distinguishes a pre-created FileSystemBackend from a FileSystemConfig.
 * FileSystemBackend always has a `name` string and a `read` function.
 */
function isFileSystemBackend(v: unknown): v is FileSystemBackend {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).name === "string" &&
    typeof (v as Record<string, unknown>).read === "function"
  );
}

/**
 * Resolve RuntimeConfig.filesystem to a FileSystemBackend or undefined.
 *
 * Handles three cases:
 * - false / undefined → no filesystem
 * - FileSystemBackend (pre-created, e.g. via resolveFileSystemAsync) → use as-is
 * - FileSystemConfig → resolve synchronously via resolveFileSystem
 */
function resolveFilesystemInput(
  input: RuntimeConfig["filesystem"],
  cwd: string | undefined,
): FileSystemBackend | undefined {
  if (input === false || input === undefined) return undefined;
  if (isFileSystemBackend(input)) return input;
  return resolveFileSystem(input, cwd ?? process.cwd());
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
