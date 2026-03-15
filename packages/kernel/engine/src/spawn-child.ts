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

import type {
  AgentId,
  ChannelAdapter,
  ChildCompletionResult,
  ChildHandle,
  ChildLifecycleEvent,
  ComponentProvider,
  DelegationComponent,
  DelegationId,
  EngineEvent,
  EngineInput,
} from "@koi/core";
import { channelToken, DEFAULT_SPAWN_CHANNEL_POLICY, DELEGATION, ENV } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createAgentEnvProvider } from "./agent-env-provider.js";
import { createChildHandle } from "./child-handle.js";
import { computeChildDelegationScope } from "./compute-delegation-scope.js";
import { createInheritedChannel } from "./inherited-channel.js";
import { createInheritedComponentProvider } from "./inherited-component-provider.js";
import { createKoi } from "./koi.js";
import type { KoiRuntime, SpawnChildOptions, SpawnChildResult } from "./types.js";

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

export async function spawnChildAgent(options: SpawnChildOptions): Promise<SpawnChildResult> {
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

  // 2. Resolve inheritance config (backward compat: scopeChecker → inheritance.tools)
  const inheritance = options.inheritance ?? {};
  const scopeChecker = inheritance.tools?.scopeChecker ?? options.scopeChecker;

  // 3. Build inherited component provider (scope-filtered)
  const inheritedProvider = createInheritedComponentProvider({
    parent: options.parentAgent,
    ...(scopeChecker !== undefined ? { scopeChecker } : {}),
  });

  // 4. Build additional providers from inheritance config
  const inheritanceProviders: ComponentProvider[] = [];

  // 4a. Env inheritance
  const parentHasEnv = options.parentAgent.has(ENV);
  if (parentHasEnv) {
    const envOverrides = inheritance.env?.overrides;
    inheritanceProviders.push(
      createAgentEnvProvider({
        parent: options.parentAgent,
        ...(envOverrides !== undefined ? { overrides: envOverrides } : {}),
      }),
    );
  }

  // 4b. Channel inheritance
  const channelPolicy = inheritance.channels ?? DEFAULT_SPAWN_CHANNEL_POLICY;
  if (channelPolicy.mode !== "none") {
    const parentChannels = options.parentAgent.query("channel:");
    for (const [tokenKey, channel] of parentChannels) {
      const tokenStr = tokenKey as string;
      const channelName = tokenStr.slice("channel:".length);
      const proxy = createInheritedChannel(
        channel as ChannelAdapter,
        options.parentAgent.pid,
        channelPolicy,
      );
      // Wrap as a simple component provider
      const channelProvider: ComponentProvider = {
        name: `inherited-channel:${channelName}`,
        attach: async () => new Map([[channelToken(channelName) as string, proxy]]),
      };
      inheritanceProviders.push(channelProvider);
    }
  }

  // 5. Create AbortController for child signal/terminate support
  const abortController = new AbortController();

  // 6. Resolve priority
  const childPriority = inheritance.priority ?? 10;

  // 7. Delegate to createKoi with child-specific options
  //    Manifest lifecycle drives agentType — no explicit agentType override needed.
  let childRuntime: KoiRuntime;
  try {
    childRuntime = await createKoi({
      manifest: options.manifest,
      adapter: options.adapter,
      parentPid: options.parentAgent.pid,
      providers: [inheritedProvider, ...inheritanceProviders, ...(options.providers ?? [])],
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
      metadata: { name: options.manifest.name },
      registeredAt: Date.now(),
      parentId: options.parentAgent.pid.id,
      spawner: options.parentAgent.pid.id,
      priority: childPriority,
      ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
    });
  }

  // 6. Auto-delegation: grant attenuated scope to child if parent has DELEGATION component.
  //    When the grant carries a Nexus proof, extract the per-child API key and
  //    inject it into the child's env. This is the in-process equivalent of the
  //    Temporal path where WorkerWorkflowConfig.nexusApiKey carries the key.
  let childGrantId: DelegationId | undefined; // let justified: mutable for cleanup on failure
  let childNexusApiKey: string | undefined; // let justified: set once from proof.token
  const parentHasDelegation = options.parentAgent.has(DELEGATION);

  if (parentHasDelegation && options.manifest.delegation?.enabled !== false) {
    const parentDelegation = options.parentAgent.component<DelegationComponent>(DELEGATION);
    if (parentDelegation !== undefined) {
      const parentPermissions = options.parentAgent.manifest.permissions ?? {};
      const childPermissions = options.manifest.permissions ?? {};
      const childScope = computeChildDelegationScope(
        { permissions: parentPermissions },
        childPermissions,
      );
      const delegationRequired = options.manifest.delegation?.required === true;
      try {
        const grant = await parentDelegation.grant(childScope, childPid.id);
        childGrantId = grant.id;
        // Extract per-child Nexus API key from grant proof.
        // CapabilityProof is an L0 discriminated union — L1 reads its variants
        // to map proof kinds to child env vars. This is L1's job: it bridges
        // L0 contracts to runtime concerns. Revised from original Decision #1-A
        // because the provider-based approach leaked the bootstrap key (codex
        // review finding #2).
        if (grant.proof.kind === "nexus") {
          childNexusApiKey = grant.proof.token;
        }
      } catch (e: unknown) {
        if (delegationRequired) {
          // Release ledger slot before re-throwing — no leak
          const release = options.spawnLedger.release();
          await release;
          throw KoiRuntimeError.from(
            "PERMISSION",
            `Delegation required but grant failed: ${e instanceof Error ? e.message : String(e)}`,
            { retryable: false, context: { childId: childPid.id }, cause: e },
          );
        }
        // Graceful degradation: child operates without delegation
        console.error(
          `[spawn-child] delegation grant failed for child "${childPid.id}", continuing without delegation`,
          e,
        );
      }
    }
  }

  // 7. Wrap runtime.run() to compose the abort signal from the child handle.
  //    This ensures that handle.signal(TERM) → abortController.abort() reaches the
  //    engine loop's AbortSignal, enabling graceful in-flight shutdown during the
  //    grace period before force-termination.
  function wrappedRun(input: EngineInput): AsyncIterable<EngineEvent> {
    const composedSignal =
      input.signal !== undefined
        ? AbortSignal.any([input.signal, abortController.signal])
        : abortController.signal;
    return childRuntime.run({ ...input, signal: composedSignal });
  }

  // 8. Create child handle for lifecycle monitoring + determine dispose override
  let handle: ChildHandle;
  let disposeOverride: (() => Promise<void>) | undefined;

  if (options.registry !== undefined) {
    const reg = options.registry;
    handle = createChildHandle(
      childPid.id,
      options.manifest.name,
      reg,
      abortController,
      options.gracePeriodMs,
    );

    // Parent termination → child cascade is handled by CascadingTermination
    // (centralized, supervision-aware). No per-child watcher needed here.

    // 9. Wire ledger release + runtime disposal + delegation revoke to child termination
    //    Idempotency guard prevents double release if terminated fires multiple times.
    let released = false; // let justified: mutable idempotency flag for one-shot cleanup
    handle.onEvent((event) => {
      if (event.kind === "terminated" && !released) {
        released = true;
        const release = options.spawnLedger.release();
        void (release instanceof Promise ? release : undefined);
        void Promise.resolve(childRuntime.dispose()).catch((err: unknown) => {
          console.error(`[spawn-child] dispose failed for child "${childPid.id}"`, err);
        });

        // Revoke auto-delegation grant on child termination (best-effort)
        if (childGrantId !== undefined && parentHasDelegation) {
          const parentDel = options.parentAgent.component<DelegationComponent>(DELEGATION);
          if (parentDel !== undefined) {
            void Promise.resolve(parentDel.revoke(childGrantId, false)).catch((err: unknown) => {
              console.error(
                `[spawn-child] delegation revoke failed for child "${childPid.id}"`,
                err,
              );
            });
          }
        }
      }
    });
  } else {
    // No-registry path: wire ledger release to dispose.
    // Without a registry, there is no termination event to trigger cleanup,
    // so we intercept dispose() to release the ledger slot that would otherwise leak.
    let released = false; // let justified: mutable idempotency flag for one-shot cleanup
    const originalDispose = childRuntime.dispose;
    disposeOverride = async (): Promise<void> => {
      if (!released) {
        released = true;
        const release = options.spawnLedger.release();
        void (release instanceof Promise ? release : undefined);
      }
      await originalDispose();
    };
    handle = createNoopChildHandle(childPid.id, options.manifest.name);
  }

  const wrappedRuntime: KoiRuntime = {
    ...childRuntime,
    run: wrappedRun,
    ...(disposeOverride !== undefined ? { dispose: disposeOverride } : {}),
  };

  return {
    runtime: wrappedRuntime,
    handle,
    childPid,
    ...(childNexusApiKey !== undefined ? { nexusApiKey: childNexusApiKey } : {}),
    ...(childGrantId !== undefined ? { delegationId: childGrantId } : {}),
  };
}
