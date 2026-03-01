/**
 * spawnChildAgent() — orchestrates child agent creation from a forged artifact.
 *
 * Responsibilities:
 * 1. Acquire ledger slot (tree-wide, released on child termination — NOT tool call duration)
 * 2. Build InheritedComponentProvider for parent tool inheritance
 * 3. Delegate to createKoi() with child-specific options
 * 4. Register child in registry (if provided)
 * 5. Create ChildHandle for lifecycle monitoring
 * 6. (Handled externally by CascadingTermination — supervision-aware)
 * 7. Wire ledger release + runtime disposal to child termination event
 */

import type { AgentId, ChildCompletionResult, ChildHandle, ChildLifecycleEvent } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createChildHandle } from "./child-handle.js";
import { createInheritedComponentProvider } from "./inherited-component-provider.js";
import { createKoi } from "./koi.js";
import type { KoiRuntime, SpawnChildOptions, SpawnResult } from "./types.js";

// ---------------------------------------------------------------------------
// Noop child handle — used when no registry is provided
// ---------------------------------------------------------------------------

function createNoopChildHandle(childId: AgentId, name: string): ChildHandle {
  return {
    childId,
    name,
    onEvent: (_listener: (event: ChildLifecycleEvent) => void): (() => void) => {
      return () => {};
    },
    signal: () => {},
    terminate: () => {},
    waitForCompletion: (): Promise<ChildCompletionResult> => {
      return Promise.resolve({ childId, exitCode: 0 });
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function spawnChildAgent(options: SpawnChildOptions): Promise<SpawnResult> {
  // 1. Acquire ledger slot (tree-wide process count)
  //    Long-lived — released on child termination, not on tool call completion.
  //    Fan-out (short-lived) is handled by the spawn guard middleware.
  const acquired = options.spawnLedger.acquire();
  // acquire() returns boolean | Promise<boolean> per L0 interface
  const didAcquire = await acquired;
  if (!didAcquire) {
    const active = options.spawnLedger.activeCount();
    const cap = options.spawnLedger.capacity();
    throw KoiRuntimeError.from("RATE_LIMIT", `Max total processes exceeded: ${active}/${cap}`, {
      retryable: true,
      context: { activeProcesses: active, maxTotalProcesses: cap },
    });
  }

  // 2. Build inherited component provider (scope-filtered)
  const inheritedProvider = createInheritedComponentProvider({
    parent: options.parentAgent,
    ...(options.scopeChecker !== undefined ? { scopeChecker: options.scopeChecker } : {}),
  });

  // 3. Create AbortController for child signal/terminate support
  const abortController = new AbortController();

  // 4. Delegate to createKoi with child-specific options
  //    Manifest lifecycle drives agentType — no explicit agentType override needed.
  let childRuntime: KoiRuntime;
  try {
    childRuntime = await createKoi({
      manifest: options.manifest,
      adapter: options.adapter,
      parentPid: options.parentAgent.pid,
      providers: [inheritedProvider, ...(options.providers ?? [])],
      spawnLedger: options.spawnLedger,
      spawn: options.spawnPolicy,
      ...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
      ...(options.forge !== undefined ? { forge: options.forge } : {}),
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.loopDetection !== undefined ? { loopDetection: options.loopDetection } : {}),
      ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    });
  } catch (e: unknown) {
    // Release ledger slot on assembly failure — no leak
    const release = options.spawnLedger.release();
    await release;
    throw e;
  }

  const childPid = childRuntime.agent.pid;

  // 5. Register child in registry (if provided)
  if (options.registry !== undefined) {
    const childAgentType = childPid.type;
    await options.registry.register({
      agentId: childPid.id,
      status: {
        phase: "created",
        generation: 0,
        conditions: [],
        lastTransitionAt: Date.now(),
      },
      agentType: childAgentType,
      metadata: {},
      registeredAt: Date.now(),
      parentId: options.parentAgent.pid.id,
      spawner: options.parentAgent.pid.id,
      ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
    });
  }

  // 6. Create child handle for lifecycle monitoring
  let handle: ChildHandle;
  if (options.registry !== undefined) {
    const reg = options.registry;
    handle = createChildHandle(
      childPid.id,
      options.manifest.name,
      reg,
      abortController,
      options.gracePeriodMs,
    );

    // 7. Parent termination → child cascade is handled by CascadingTermination
    //    (centralized, supervision-aware). No per-child watcher needed here.

    // 8. Wire ledger release + runtime disposal to child termination
    //    Idempotency guard prevents double release if terminated fires multiple times.
    let released = false; // let justified: mutable idempotency flag for one-shot cleanup
    handle.onEvent((event) => {
      if (event.kind === "terminated" && !released) {
        released = true;
        const release = options.spawnLedger.release();
        void (release instanceof Promise ? release : undefined);
        void childRuntime.dispose();
      }
    });
  } else {
    handle = createNoopChildHandle(childPid.id, options.manifest.name);
  }

  return {
    runtime: childRuntime,
    handle,
    childPid,
  };
}
