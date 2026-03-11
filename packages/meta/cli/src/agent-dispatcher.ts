/**
 * createAgentDispatcher — factory for dispatching new agents from the admin panel.
 *
 * Implements CommandDispatcher["dispatchAgent"] by loading a manifest,
 * resolving the agent, creating an engine adapter, and starting the
 * runtime. Tracks dispatched agents for lifecycle management.
 */

import type { AgentId, KoiError, Result } from "@koi/core";
import type {
  CommandDispatcher,
  DispatchAgentRequest,
  DispatchAgentResponse,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A dispatched agent with its runtime handle. */
export interface DispatchedAgent {
  readonly agentId: AgentId;
  readonly name: string;
  readonly startedAt: number;
  readonly dispose: () => Promise<void>;
}

export interface AgentDispatcherOptions {
  /** Default manifest path (used when request omits manifest). */
  readonly defaultManifestPath: string;
  /** Emit verbose diagnostics to stderr. */
  readonly verbose?: boolean;
}

export interface AgentDispatcherResult {
  /** The dispatchAgent function to pass to createAdminPanelBridge. */
  readonly dispatchAgent: NonNullable<CommandDispatcher["dispatchAgent"]>;
  /** Read-only view of currently dispatched agents. */
  readonly dispatched: ReadonlyMap<string, DispatchedAgent>;
  /** Dispose all dispatched agent runtimes. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an agent dispatcher that can be wired into the admin panel bridge.
 *
 * Heavy dependencies (resolveAgent, forge, engine-pi, manifest) are loaded
 * lazily on first dispatch to avoid slowing down bridge construction.
 */
export function createAgentDispatcher(options: AgentDispatcherOptions): AgentDispatcherResult {
  const dispatched = new Map<string, DispatchedAgent>();

  // Lazy-loaded dependencies — resolved once on first dispatch.
  // Uses dynamic import() to avoid pulling heavy deps at bridge construction time.
  // Function signatures are inline to avoid depending on potentially-unresolved
  // module type declarations (e.g. @koi/forge, @koi/manifest).
  interface LazyDeps {
    readonly resolveAgent: (opts: {
      readonly manifestPath: string;
      readonly manifest: unknown;
    }) => Promise<
      Result<{ readonly middleware: readonly unknown[]; readonly engine?: unknown }, KoiError>
    >;
    readonly createForgeConfiguredKoi: (opts: {
      readonly manifest: unknown;
      readonly adapter: unknown;
      readonly middleware: readonly unknown[];
      readonly providers: readonly unknown[];
      readonly extensions: readonly unknown[];
    }) => Promise<{
      readonly runtime: {
        readonly agent: { readonly pid: { readonly id: AgentId } };
        readonly run: (input: {
          readonly kind: string;
          readonly text: string;
        }) => AsyncIterable<unknown>;
        readonly dispose: () => Promise<void>;
      };
    }>;
    readonly createPiAdapter: (opts: { readonly model: string }) => unknown;
    readonly loadManifest: (
      path: string,
    ) => Promise<
      Result<
        { readonly manifest: { readonly name: string; readonly model: { readonly name: string } } },
        KoiError
      >
    >;
  }

  // let justified: cached promise for lazy dependency loading
  let depsPromise: Promise<LazyDeps> | undefined;

  async function loadDeps(): Promise<LazyDeps> {
    const [resolveAgentMod, forgeMod, piMod, manifestMod] = await Promise.all([
      import("./resolve-agent.js"),
      import("@koi/forge"),
      import("@koi/engine-pi"),
      import("@koi/manifest"),
    ]);
    return {
      resolveAgent: resolveAgentMod.resolveAgent as LazyDeps["resolveAgent"],
      createForgeConfiguredKoi:
        forgeMod.createForgeConfiguredKoi as LazyDeps["createForgeConfiguredKoi"],
      createPiAdapter: piMod.createPiAdapter as LazyDeps["createPiAdapter"],
      loadManifest: manifestMod.loadManifest as LazyDeps["loadManifest"],
    };
  }

  function getDeps(): Promise<LazyDeps> {
    if (depsPromise === undefined) {
      depsPromise = loadDeps();
    }
    return depsPromise;
  }

  const dispatchAgent: NonNullable<CommandDispatcher["dispatchAgent"]> = async (
    request: DispatchAgentRequest,
  ): Promise<Result<DispatchAgentResponse, KoiError>> => {
    const manifestPath = request.manifest ?? options.defaultManifestPath;

    try {
      const deps = await getDeps();

      // 1. Load manifest
      const loadResult = await deps.loadManifest(manifestPath);
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

      const { manifest } = loadResult.value;

      // 2. Resolve agent (middleware, model, engine)
      const resolved = await deps.resolveAgent({ manifestPath, manifest });
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

      // 4. Create runtime
      const { runtime } = await deps.createForgeConfiguredKoi({
        manifest,
        adapter,
        middleware: [...resolved.value.middleware],
        providers: [],
        extensions: [],
      });

      const id = runtime.agent.pid.id;

      dispatched.set(id, {
        agentId: id,
        name: request.name,
        startedAt: Date.now(),
        dispose: () => runtime.dispose(),
      });

      if (options.verbose) {
        process.stderr.write(`Dispatched agent "${request.name}" (${id})\n`);
      }

      // 5. If an initial message was provided, run it asynchronously
      if (request.message !== undefined && request.message.trim() !== "") {
        const msg = request.message;
        void (async (): Promise<void> => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _event of runtime.run({ kind: "text", text: msg })) {
              // Consume events — dispatched agent runs autonomously
            }
          } catch (e: unknown) {
            if (options.verbose) {
              const errMsg = e instanceof Error ? e.message : String(e);
              process.stderr.write(`warn: dispatched agent "${request.name}" error: ${errMsg}\n`);
            }
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

  const dispose = async (): Promise<void> => {
    const entries = [...dispatched.values()];
    dispatched.clear();
    await Promise.allSettled(entries.map((a) => a.dispose()));
  };

  return { dispatchAgent, dispatched, dispose };
}
