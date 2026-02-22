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
import type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
import { createLifecycle, transition } from "./lifecycle.js";

export class AgentEntity implements Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;

  private _lifecycle: AgentLifecycle;
  private _components: ReadonlyMap<string, unknown> = new Map();
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
  ): Promise<AgentEntity> {
    const agent = new AgentEntity(pid, manifest);
    const merged = new Map<string, unknown>();

    for (const provider of providers) {
      const components = await provider.attach(agent);
      for (const [key, value] of components) {
        merged.set(key, value);
      }
    }

    agent._components = merged;
    agent._queryCache.clear();
    return agent;
  }
}
