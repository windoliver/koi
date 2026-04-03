/**
 * createAgentDispatcher — factory for dispatching new agents from the admin panel.
 *
 * Implements CommandDispatcher["dispatchAgent"] by loading a manifest,
 * resolving the agent, creating an engine adapter, and starting the
 * runtime. Tracks dispatched agents for lifecycle management.
 *
 * Each dispatched agent gets its own AG-UI stream middleware and
 * RunContextStore, enabling independent chat via POST /agents/:id/chat.
 */

import type { AgentId, InboundMessage, KoiError, KoiMiddleware, Result } from "@koi/core";
import type {
  CommandDispatcher,
  DispatchAgentRequest,
  DispatchAgentResponse,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A dispatched agent with its runtime handle and chat endpoint. */
export interface DispatchedAgent {
  readonly agentId: AgentId;
  readonly name: string;
  readonly startedAt: number;
  readonly dispose: () => Promise<void>;
  /** Handle an AG-UI chat request for this specific agent. */
  readonly chatHandler: (req: Request) => Promise<Response>;
}

/** Manifest field overrides applied after loading, keyed by agent display name. */
export interface ManifestOverrides {
  readonly name?: string;
  readonly description?: string;
}

export interface AgentDispatcherOptions {
  /** Default manifest path (used when request omits manifest). */
  readonly defaultManifestPath: string;
  /** Emit verbose diagnostics to stderr. */
  readonly verbose?: boolean;
  /** Additional middleware to include in every dispatched agent's runtime. */
  readonly additionalMiddleware?: readonly KoiMiddleware[];
  /** Additional providers to include in every dispatched agent's runtime. */
  readonly additionalProviders?: readonly unknown[];
  /** Additional extensions to include in every dispatched agent's runtime. */
  readonly additionalExtensions?: readonly unknown[];
  /** ForgeStore from host bootstrap — passed to resolveAgent for companion skill registration. */
  readonly forgeStore?: unknown;
  /** Forge runtime from host bootstrap — passed to createForgeConfiguredKoi as `forge`. */
  readonly forgeRuntime?: unknown;
  /** Optional SSE event sink for forge/monitor observability on dispatched agents. */
  readonly onDashboardEvent?: ((event: unknown) => void) | undefined;
  /**
   * Per-agent manifest overrides — keyed by display name from DispatchAgentRequest.
   * Applied after loading the manifest to give dispatched agents unique identities.
   */
  readonly manifestOverrides?: ReadonlyMap<string, ManifestOverrides> | undefined;
  /** Injected deps for testing — bypasses dynamic import() to avoid mock.module contamination. */
  readonly _testDeps?: DispatcherDeps;
}

export interface AgentDispatcherResult {
  /** The dispatchAgent function to pass to createAdminPanelBridge. */
  readonly dispatchAgent: NonNullable<CommandDispatcher["dispatchAgent"]>;
  /** Read-only view of currently dispatched agents. */
  readonly dispatched: ReadonlyMap<string, DispatchedAgent>;
  /** Get the chat handler for a dispatched agent (undefined if not found). */
  readonly getChatHandler: (agentId: string) => ((req: Request) => Promise<Response>) | undefined;
  /** Terminate and dispose a specific dispatched agent by ID. Returns true if found and disposed. */
  readonly terminateAgent: (id: string) => Promise<boolean>;
  /** Dispose all dispatched agent runtimes. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Lazy dependency interface — extracted for testability (_testDeps injection).
// ---------------------------------------------------------------------------

/** Heavy deps loaded lazily on first dispatch (or injected via _testDeps). */
export interface DispatcherDeps {
  readonly resolveAgent: (opts: {
    readonly manifestPath: string;
    readonly manifest: unknown;
    readonly forgeStore?: unknown;
  }) => Promise<
    Result<{ readonly middleware: readonly unknown[]; readonly engine?: unknown }, KoiError>
  >;
  readonly createForgeConfiguredKoi: (opts: {
    readonly manifest: unknown;
    readonly adapter: unknown;
    readonly middleware: readonly unknown[];
    readonly providers: readonly unknown[];
    readonly extensions: readonly unknown[];
    readonly forge?: unknown;
    readonly onDashboardEvent?: ((event: unknown) => void) | undefined;
  }) => Promise<{
    readonly runtime: {
      readonly agent: { readonly pid: { readonly id: AgentId } };
      readonly run: (input: {
        readonly kind: string;
        readonly text: string;
      }) => AsyncIterable<unknown>;
      readonly dispose: () => Promise<void>;
    };
    /** Tear down forge system internals. Call after runtime.dispose(). */
    readonly dispose: () => void;
  }>;
  readonly createPiAdapter: (opts: { readonly model: string }) => unknown;
  readonly loadManifest: (path: string) => Promise<
    Result<
      {
        readonly manifest: {
          readonly name: string;
          readonly model: { readonly name: string };
          readonly lifecycle?: "copilot" | "worker" | undefined;
        };
      },
      KoiError
    >
  >;
  // AG-UI streaming deps
  readonly createRunContextStore: () => {
    readonly register: (runId: string, writer: unknown, signal: AbortSignal) => void;
    readonly get: (runId: string) => unknown;
    readonly deregister: (runId: string) => void;
    readonly markTextStreamed: (runId: string) => void;
    readonly hasTextStreamed: (runId: string) => boolean;
    readonly size: number;
  };
  readonly createAguiStreamMiddleware: (config: { readonly store: unknown }) => KoiMiddleware;
  readonly handleAguiRequest: (
    req: Request,
    store: unknown,
    mode: "stateful" | "stateless",
    dispatch: (message: InboundMessage) => Promise<void>,
  ) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an agent dispatcher that can be wired into the admin panel bridge.
 *
 * Heavy dependencies (resolveAgent, forge, engine-pi, manifest, channel-agui)
 * are loaded lazily on first dispatch to avoid slowing down bridge construction.
 */
export function createAgentDispatcher(options: AgentDispatcherOptions): AgentDispatcherResult {
  const dispatched = new Map<string, DispatchedAgent>();

  // let justified: cached promise for lazy dependency loading
  let depsPromise: Promise<DispatcherDeps> | undefined;

  async function loadDeps(): Promise<DispatcherDeps> {
    const [resolveAgentMod, forgeMod, piMod, manifestMod, aguiMod] = await Promise.all([
      import("./resolve-agent.js"),
      import("@koi/forge"),
      import("@koi/engine-pi"),
      import("@koi/manifest"),
      import("@koi/channel-agui"),
    ]);
    return {
      resolveAgent: resolveAgentMod.resolveAgent as DispatcherDeps["resolveAgent"],
      createForgeConfiguredKoi:
        forgeMod.createForgeConfiguredKoi as DispatcherDeps["createForgeConfiguredKoi"],
      createPiAdapter: piMod.createPiAdapter as DispatcherDeps["createPiAdapter"],
      loadManifest: manifestMod.loadManifest as DispatcherDeps["loadManifest"],
      createRunContextStore:
        aguiMod.createRunContextStore as DispatcherDeps["createRunContextStore"],
      createAguiStreamMiddleware:
        aguiMod.createAguiStreamMiddleware as DispatcherDeps["createAguiStreamMiddleware"],
      handleAguiRequest: aguiMod.handleAguiRequest as DispatcherDeps["handleAguiRequest"],
    };
  }

  function getDeps(): Promise<DispatcherDeps> {
    if (depsPromise === undefined) {
      depsPromise =
        options._testDeps !== undefined ? Promise.resolve(options._testDeps) : loadDeps();
    }
    return depsPromise;
  }

  /** Extract text from InboundMessage content blocks. */
  function extractText(msg: InboundMessage): string {
    return msg.content
      .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
      .map((b) => b.text)
      .join("\n");
  }

  const dispatchAgent: NonNullable<CommandDispatcher["dispatchAgent"]> = async (
    request: DispatchAgentRequest,
  ): Promise<Result<DispatchAgentResponse, KoiError>> => {
    const manifestPath = request.manifest ?? options.defaultManifestPath;

    try {
      const deps = await getDeps();

      // 1. Load manifest
      const loadResult = await deps.loadManifest(manifestPath, undefined, {
        rejectUnsupportedHooks: true,
      });
      if (!loadResult.ok) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Manifest load failed: ${loadResult.error.message}`,
            retryable: false,
          },
        };
      }

      const baseManifest = loadResult.value.manifest;

      // Override lifecycle when dispatcher specifies agentType (e.g. worker vs copilot)
      const withLifecycle =
        request.agentType !== undefined && request.agentType !== baseManifest.lifecycle
          ? { ...baseManifest, lifecycle: request.agentType }
          : baseManifest;

      // Apply per-agent manifest overrides (name, description) for unique identities
      const agentOverrides = options.manifestOverrides?.get(request.name);
      const manifest =
        agentOverrides !== undefined
          ? {
              ...withLifecycle,
              ...(agentOverrides.name !== undefined ? { name: agentOverrides.name } : {}),
              ...(agentOverrides.description !== undefined
                ? { description: agentOverrides.description }
                : {}),
            }
          : withLifecycle;

      // 2. Resolve agent (middleware, model, engine)
      const resolved = await deps.resolveAgent({
        manifestPath,
        manifest,
        ...(options.forgeStore !== undefined ? { forgeStore: options.forgeStore } : {}),
      });
      if (!resolved.ok) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Agent resolution failed: ${resolved.error.message}`,
            retryable: false,
          },
        };
      }

      // 3. Create engine adapter
      const adapter = resolved.value.engine ?? deps.createPiAdapter({ model: manifest.model.name });

      // 4. Create per-agent AG-UI store + middleware for chat streaming
      const store = deps.createRunContextStore();
      const aguiMiddleware = deps.createAguiStreamMiddleware({ store });

      // 5. Create runtime with AG-UI middleware included
      const { runtime, dispose: forgeDispose } = await deps.createForgeConfiguredKoi({
        manifest,
        adapter,
        middleware: [
          ...(options.additionalMiddleware ?? []),
          ...resolved.value.middleware,
          aguiMiddleware,
        ],
        providers: options.additionalProviders ?? [],
        extensions: options.additionalExtensions ?? [],
        ...(options.forgeRuntime !== undefined ? { forge: options.forgeRuntime } : {}),
        ...(options.onDashboardEvent !== undefined
          ? { onDashboardEvent: options.onDashboardEvent }
          : {}),
      });

      const id = runtime.agent.pid.id;

      // Concurrency guard for single-flight runtime.run()
      // let justified: guards against concurrent chat + initial message
      let busy = false;

      // Chat dispatch function for handleAguiRequest
      const chatDispatch = async (msg: InboundMessage): Promise<void> => {
        if (busy) throw new Error("Agent is busy processing another request");
        busy = true;
        try {
          const text = extractText(msg);
          if (text.trim() === "") return;
          for await (const _event of runtime.run({ kind: "text", text })) {
            // Events consumed — AG-UI middleware streams them to SSE writer
          }
        } finally {
          busy = false;
        }
      };

      // Chat handler for this dispatched agent
      const chatHandler = async (req: Request): Promise<Response> =>
        deps.handleAguiRequest(req, store, "stateless", chatDispatch);

      dispatched.set(id, {
        agentId: id,
        name: request.name,
        startedAt: Date.now(),
        dispose: async () => {
          await runtime.dispose();
          forgeDispose();
        },
        chatHandler,
      });

      if (options.verbose) {
        process.stderr.write(`Dispatched agent "${request.name}" (${id})\n`);
      }

      // 6. If an initial message was provided, run it asynchronously
      if (request.message !== undefined && request.message.trim() !== "") {
        const msg = request.message;
        busy = true;
        void (async (): Promise<void> => {
          try {
            for await (const _event of runtime.run({ kind: "text", text: msg })) {
              // Consume events — dispatched agent runs autonomously
            }
          } catch (e: unknown) {
            if (options.verbose) {
              const errMsg = e instanceof Error ? e.message : String(e);
              process.stderr.write(`warn: dispatched agent "${request.name}" error: ${errMsg}\n`);
            }
          } finally {
            busy = false;
          }
        })();
      }

      return {
        ok: true,
        value: { agentId: id, name: request.name },
      };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        },
      };
    }
  };

  const getChatHandler = (agentId: string): ((req: Request) => Promise<Response>) | undefined => {
    return dispatched.get(agentId)?.chatHandler;
  };

  const terminateAgent = async (id: string): Promise<boolean> => {
    const agent = dispatched.get(id);
    if (agent === undefined) return false;
    dispatched.delete(id);
    await agent.dispose();
    return true;
  };

  const dispose = async (): Promise<void> => {
    const entries = [...dispatched.values()];
    dispatched.clear();
    await Promise.allSettled(entries.map((a) => a.dispose()));
  };

  return { dispatchAgent, dispatched, getChatHandler, terminateAgent, dispose };
}
