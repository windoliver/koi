/**
 * Generic Backend+Tools ComponentProvider factory.
 *
 * Extracts the common pattern from FileSystemProvider, BrowserProvider,
 * WebhookProvider, and SchedulerProvider into a reusable factory.
 *
 * Exception: permitted in L0 as a pure function operating only on L0 types
 * (ComponentProvider, SubsystemToken, Tool, ToolPolicy, Agent).
 */

import type { Agent, ComponentProvider, SubsystemToken, Tool, ToolPolicy } from "./ecs.js";
import { DEFAULT_UNSANDBOXED_POLICY, toolToken } from "./ecs.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ServiceProviderConfig<TBackend, TOperation extends string> {
  /** Provider name (e.g., "filesystem:local", "browser:playwright"). */
  readonly name: string;

  /**
   * Well-known singleton token (e.g., FILESYSTEM, BROWSER, WEBHOOK).
   * When provided, the backend is attached under this token alongside tools.
   * Omit for tool-only providers.
   */
  readonly singletonToken?: SubsystemToken<TBackend> | undefined;

  /** Backend instance attached under singletonToken and passed to tool factories. */
  readonly backend?: TBackend | undefined;

  /** Operations to include — each maps to a tool factory. Must be non-empty, no duplicates. */
  readonly operations: readonly TOperation[];

  /** Map of operation name → tool factory function. */
  readonly factories: Readonly<
    Record<TOperation, (backend: TBackend, prefix: string, policy: ToolPolicy) => Tool>
  >;

  /** Tool policy for all standard tools. Defaults to DEFAULT_UNSANDBOXED_POLICY. */
  readonly policy?: ToolPolicy | undefined;

  /** Prefix for tool names. Defaults to empty string. */
  readonly prefix?: string | undefined;

  /** Assembly priority. Lower = higher precedence. */
  readonly priority?: number | undefined;

  /**
   * Cache the component Map after first attach. Defaults to true.
   * Set to false for providers that create per-agent components (e.g., Scheduler).
   */
  readonly cache?: boolean | undefined;

  /**
   * Hook to append extra tools alongside the standard TOOL_FACTORIES tools.
   * Receives the backend and agent, returns additional [key, value] pairs.
   * Use for special-cased tools (e.g., Browser's navigate with security config).
   */
  readonly customTools?: (
    backend: TBackend,
    agent: Agent,
  ) => ReadonlyArray<readonly [string, unknown]>;

  /**
   * Cleanup callback invoked on detach. Receives the backend.
   * Omit if no cleanup is needed (provider will have no detach method).
   */
  readonly detach?: (backend: TBackend) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that attaches a backend singleton token
 * and Tool components from a factories map.
 *
 * Centralizes the repeated pattern of:
 * 1. Iterate operations → call factory → collect [toolToken(name), tool]
 * 2. Return Map([[SINGLETON_TOKEN, backend], ...toolEntries])
 * 3. Optionally cache the Map after first attach
 * 4. Optionally call backend.dispose on detach
 *
 * @throws {Error} if operations is empty or contains duplicates.
 */
export function createServiceProvider<TBackend, TOperation extends string>(
  config: ServiceProviderConfig<TBackend, TOperation>,
): ComponentProvider {
  const {
    name,
    singletonToken,
    backend,
    operations,
    factories,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "",
    priority,
    cache: cacheOverride,
    customTools,
    detach,
  } = config;

  // Default cache to false when customTools is agent-aware (receives agent param),
  // since caching would bind the first agent's identity to all subsequent callers.
  const shouldCache = cacheOverride ?? customTools === undefined;

  // Validation — programmer errors, throw immediately
  if (operations.length === 0) {
    throw new Error(`createServiceProvider("${name}"): operations must not be empty`);
  }

  const uniqueOps = new Set(operations);
  if (uniqueOps.size !== operations.length) {
    const dupes = operations.filter((op, i) => operations.indexOf(op) !== i);
    throw new Error(`createServiceProvider("${name}"): duplicate operations: ${dupes.join(", ")}`);
  }

  // let justified: mutable cache (set once on first attach when shouldCache=true)
  let cached: ReadonlyMap<string, unknown> | undefined;

  function buildComponents(agent: Agent): ReadonlyMap<string, unknown> {
    const entries: Array<readonly [string, unknown]> = [];

    // Singleton token entry
    if (singletonToken !== undefined && backend !== undefined) {
      entries.push([singletonToken as string, backend]);
    }

    // Standard tool entries from factories
    for (const op of operations) {
      const factory = factories[op];
      const tool = factory(backend as TBackend, prefix, policy);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    }

    // Custom tool entries (escape hatch for special cases)
    if (customTools !== undefined && backend !== undefined) {
      const extras = customTools(backend, agent);
      for (const entry of extras) {
        entries.push(entry);
      }
    }

    return new Map(entries);
  }

  const provider: ComponentProvider = {
    name,
    ...(priority !== undefined ? { priority } : {}),

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (shouldCache) {
        if (cached !== undefined) return cached;
        cached = buildComponents(agent);
        return cached;
      }
      return buildComponents(agent);
    },

    ...(detach !== undefined && backend !== undefined
      ? {
          detach: async (_agent: Agent): Promise<void> => {
            await detach(backend);
          },
        }
      : {}),
  };

  return provider;
}
