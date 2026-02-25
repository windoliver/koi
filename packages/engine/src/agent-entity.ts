/**
 * AgentEntity — concrete implementation of the Agent ECS entity.
 *
 * Components are attached during assembly (via ComponentProvider.attach())
 * and frozen afterward. Lifecycle state is managed internally by the engine loop.
 */

import type {
  Agent,
  AgentManifest,
  ComponentProvider,
  ProcessId,
  ProcessState,
  SubsystemToken,
} from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
import { createLifecycle, transition } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Assembly result types
// ---------------------------------------------------------------------------

export interface AssemblyConflict {
  readonly key: string;
  readonly winner: string;
  readonly shadowed: readonly string[];
}

export interface AssemblyResult {
  readonly agent: AgentEntity;
  readonly conflicts: readonly AssemblyConflict[];
}

export class AgentEntity implements Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;

  private _lifecycle: AgentLifecycle;
  private _components: ReadonlyMap<string, unknown> = new Map();
  /**
   * Prefix query cache. Safe because components are immutable after assembly.
   * If runtime component modification is added (e.g., Forge), this cache
   * needs a version counter or invalidation mechanism.
   */
  private _queryCache = new Map<string, ReadonlyMap<string, unknown>>();

  constructor(pid: ProcessId, manifest: AgentManifest) {
    this.pid = pid;
    this.manifest = manifest;
    this._lifecycle = createLifecycle();
  }

  // ---------------------------------------------------------------------------
  // Agent interface
  // ---------------------------------------------------------------------------

  get state(): ProcessState {
    return this._lifecycle.state;
  }

  component<T>(token: SubsystemToken<T>): T | undefined {
    return this._components.get(token as string) as T | undefined;
  }

  has(token: SubsystemToken<unknown>): boolean {
    return this._components.has(token as string);
  }

  hasAll(...tokens: readonly SubsystemToken<unknown>[]): boolean {
    return tokens.every((t) => this._components.has(t as string));
  }

  query<T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> {
    const cached = this._queryCache.get(prefix);
    if (cached !== undefined) {
      return cached as ReadonlyMap<SubsystemToken<T>, T>;
    }
    const result = new Map<SubsystemToken<T>, T>();
    for (const [key, value] of this._components) {
      if (key.startsWith(prefix)) {
        result.set(key as SubsystemToken<T>, value as T);
      }
    }
    this._queryCache.set(prefix, result as ReadonlyMap<string, unknown>);
    return result;
  }

  components(): ReadonlyMap<string, unknown> {
    return this._components;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (internal — only used by engine loop)
  // ---------------------------------------------------------------------------

  /** @internal */
  get lifecycle(): AgentLifecycle {
    return this._lifecycle;
  }

  /** @internal */
  transition(event: LifecycleEvent): void {
    this._lifecycle = transition(this._lifecycle, event);
  }

  // ---------------------------------------------------------------------------
  // Assembly (static factory)
  // ---------------------------------------------------------------------------

  static async assemble(
    pid: ProcessId,
    manifest: AgentManifest,
    providers: readonly ComponentProvider[],
  ): Promise<AssemblyResult> {
    const agent = new AgentEntity(pid, manifest);
    const merged = new Map<string, unknown>();

    // Sort providers by priority ascending (lower = higher precedence).
    // Stable sort preserves registration order for same-priority providers.
    const sorted = [...providers].sort(
      (a, b) =>
        (a.priority ?? COMPONENT_PRIORITY.BUNDLED) - (b.priority ?? COMPONENT_PRIORITY.BUNDLED),
    );

    // Track which provider won each key and which were shadowed
    const winnerByKey = new Map<string, string>();
    const shadowedByKey = new Map<string, string[]>();

    for (const provider of sorted) {
      const components = await provider.attach(agent);
      for (const [key, value] of components) {
        if (!merged.has(key)) {
          // First-write-wins: highest-priority provider claims the key
          merged.set(key, value);
          winnerByKey.set(key, provider.name);
        } else {
          // Record conflict: this provider was shadowed
          const existing = shadowedByKey.get(key);
          if (existing !== undefined) {
            existing.push(provider.name);
          } else {
            shadowedByKey.set(key, [provider.name]);
          }
        }
      }
    }

    // Build conflict list
    const conflicts: readonly AssemblyConflict[] = [...shadowedByKey.entries()].map(
      ([key, shadowed]) => ({
        key,
        winner: winnerByKey.get(key) ?? "unknown",
        shadowed,
      }),
    );

    agent._components = merged;
    agent._queryCache.clear();
    return { agent, conflicts };
  }
}
