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
  AgentEnv,
  AgentId,
  ChannelAdapter,
  ChannelInheritMode,
  ChildCompletionResult,
  ChildHandle,
  ChildLifecycleEvent,
  ComponentProvider,
  DelegationComponent,
  DelegationId,
  EngineEvent,
  EngineInput,
  SpawnChannelPolicy,
  Tool,
} from "@koi/core";
import {
  channelToken,
  DEFAULT_FORK_MAX_TURNS,
  DEFAULT_SPAWN_CHANNEL_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  DELEGATION,
  ENV,
  isAttachResult,
} from "@koi/core";
import { createStructuredOutputGuard } from "@koi/engine-compose";
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
  //    When acquireOrWait is available and a signal is provided, wait for a slot
  //    instead of failing immediately at capacity (backpressure).
  let didAcquire: boolean;
  if (options.spawnLedger.acquireOrWait !== undefined && options.signal !== undefined) {
    didAcquire = await options.spawnLedger.acquireOrWait(options.signal);
  } else {
    const acquired = options.spawnLedger.acquire();
    // acquire() returns boolean | Promise<boolean> per L0 interface
    didAcquire = await acquired;
  }
  if (!didAcquire) {
    // Distinguish abort (user/system cancellation) from true capacity exhaustion.
    // acquireOrWait resolves false when the AbortSignal fires — not a RATE_LIMIT event.
    // RATE_LIMIT is retryable: true; a cancelled spawn must NOT trigger retry logic.
    if (options.spawnLedger.acquireOrWait !== undefined && options.signal?.aborted) {
      throw KoiRuntimeError.from(
        "INTERNAL",
        "Spawn cancelled: abort signal fired while waiting for a process slot",
        { retryable: false },
      );
    }
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

  // 3. Build inherited component provider (scope-filtered + denylist-filtered)
  //    When nonInteractive, also strip interactive/approval-capable tools.
  // Always exclude Spawn (and nonInteractive tools when applicable) from inheritance.
  // Spawn carries a parent-bound closure; inheriting it would mis-attribute nested
  // spawns to the ancestor. Each child that needs Spawn must get a fresh provider.
  const isFork = options.fork === true;
  const baseDenylist = expandDenylistWithAlwaysExcluded(
    options.toolDenylist !== undefined ? new Set(options.toolDenylist) : undefined,
  );
  // Apply fork recursion guard: strip Spawn from fork children (Decision 3-A).
  // Defense-in-depth alongside the !isFork check in create-agent-spawn-fn.ts which
  // prevents attaching a fresh Spawn provider. Together they ensure fork children cannot
  // delegate further — independent of system prompt or manifest configuration.
  const forkGuardedDenylist = applyForkDenylist(baseDenylist, isFork);
  // let justified: modified below when applying manifest ceiling
  let toolDenylist: ReadonlySet<string> =
    options.nonInteractive === true
      ? expandDenylistForNonInteractive(forkGuardedDenylist)
      : forkGuardedDenylist;
  // Fork inherits all parent tools (no allowlist). Regular spawns may have an allowlist.
  const baseAllowlist =
    !isFork && options.toolAllowlist !== undefined ? new Set(options.toolAllowlist) : undefined;
  // let justified: modified below when applying manifest ceiling
  let toolAllowlist: ReadonlySet<string> | undefined =
    options.nonInteractive === true && baseAllowlist !== undefined
      ? stripFromAllowlist(baseAllowlist, NON_INTERACTIVE_DENIED_TOOLS)
      : baseAllowlist;

  // Apply manifest-level spawn ceiling declared by the parent manifest.
  // The ceiling is the authoritative maximum — runtime options can only further restrict.
  // Allowlist mode: child inherits only tools in manifest.list (intersect with runtime allowlist).
  // Denylist mode: manifest.list tools are always excluded (union with runtime denylist).
  const manifestSpawn = options.parentAgent.manifest.spawn;
  if (manifestSpawn?.tools !== undefined) {
    const manifestPolicy = manifestSpawn.tools.policy ?? "denylist";
    const manifestList = new Set(manifestSpawn.tools.list ?? []);
    if (manifestPolicy === "allowlist") {
      toolAllowlist =
        toolAllowlist !== undefined
          ? intersectSets(toolAllowlist, manifestList) // runtime allowlist ∩ manifest ceiling
          : manifestList; // no runtime allowlist: manifest becomes the effective ceiling
    } else {
      toolDenylist = unionSets(toolDenylist, manifestList); // always exclude manifest-denied tools
    }
  }

  // Apply the child manifest's selfCeiling — the child's own declared maximum tool surface.
  // This is intersected with the effective allowlist regardless of what the caller requests.
  // Built-in agents (e.g. coordinator) use this to enforce delegation-only surfaces
  // automatically, even when spawned by a privileged parent without an explicit toolAllowlist.
  // selfCeilingSet is kept in scope to filter additionalTools below (injected tools must also
  // respect the ceiling — they bypass the inherited-tool path but not the manifest constraint).
  const selfCeilingTools = options.manifest.selfCeiling?.tools;
  // An empty array is authoritative (zero tools allowed) — treat it the same as a populated
  // list. Only `undefined` (field absent) means "no ceiling declared; inherit freely."
  const selfCeilingSet: ReadonlySet<string> | undefined =
    selfCeilingTools !== undefined ? new Set(selfCeilingTools) : undefined;
  if (selfCeilingSet !== undefined) {
    toolAllowlist =
      toolAllowlist !== undefined
        ? intersectSets(toolAllowlist, selfCeilingSet) // intersect with existing ceiling
        : selfCeilingSet; // no prior allowlist: self-ceiling becomes the effective ceiling
  }

  const inheritedProvider = createInheritedComponentProvider({
    parent: options.parentAgent,
    ...(scopeChecker !== undefined ? { scopeChecker } : {}),
    ...(toolDenylist !== undefined ? { toolDenylist } : {}),
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
  });

  // 4. Build additional providers from inheritance config
  const inheritanceProviders: ComponentProvider[] = [];

  // 4.0 Additional tool descriptors (e.g., HookVerdict for agent hooks).
  // Apply selfCeiling filter: injected tools must respect the child manifest's ceiling just as
  // inherited tools do — a privileged parent cannot bypass selfCeiling via additionalTools.
  if (options.additionalTools !== undefined && options.additionalTools.length > 0) {
    const allowedAdditionalTools =
      selfCeilingSet !== undefined
        ? options.additionalTools.filter((d) => selfCeilingSet.has(d.name))
        : options.additionalTools;
    if (allowedAdditionalTools.length > 0) {
      const toolEntries = allowedAdditionalTools.map((desc) => {
        const tool: Tool = {
          descriptor: desc,
          origin: "operator",
          policy: DEFAULT_UNSANDBOXED_POLICY,
          execute: async (input) => ({ result: input }),
        };
        return [`tool:${desc.name}`, tool] as const;
      });
      inheritanceProviders.push({
        name: "additional-tools",
        attach: async () => new Map(toolEntries),
      });
    }
  }

  // 4a. Env inheritance — apply manifest ceiling (spawn.env.exclude) before runtime overrides.
  // Manifest exclusions remove keys from the child env unconditionally; runtime overrides
  // further modify the result. Keys in spawn.env.exclude that don't exist in the parent env
  // are silently ignored (they're already absent — no violation to report).
  const parentHasEnv = options.parentAgent.has(ENV);
  if (parentHasEnv) {
    const parentEnvValues = options.parentAgent.component<AgentEnv>(ENV)?.values ?? {};
    const parentEnvKeys = new Set(Object.keys(parentEnvValues));

    // Translate manifest env exclusions to undefined overrides (only for keys that exist)
    const manifestExcludeOverrides: Record<string, undefined> = {};
    for (const key of manifestSpawn?.env?.exclude ?? []) {
      if (parentEnvKeys.has(key)) {
        manifestExcludeOverrides[key] = undefined;
      }
    }

    // Merge: runtime overrides applied first, then manifest exclusions (manifest always wins).
    // This ensures a manifest ceiling cannot be circumvented by a per-spawn override that
    // re-adds an excluded credential — the final removal always takes effect.
    const mergedOverrides: Readonly<Record<string, string | undefined>> = {
      ...(inheritance.env?.overrides ?? {}),
      ...manifestExcludeOverrides,
    };
    const hasOverrides = Object.keys(mergedOverrides).length > 0;

    inheritanceProviders.push(
      createAgentEnvProvider({
        parent: options.parentAgent,
        ...(hasOverrides ? { overrides: mergedOverrides } : {}),
      }),
    );
  }

  // 4b. Channel inheritance — apply manifest ceiling (spawn.channels) before runtime policy.
  // The manifest declares the most permissive channel mode allowed; runtime policy may
  // further restrict it. If manifest says "none", child gets no channels regardless of runtime.
  const runtimeChannelPolicy = inheritance.channels ?? DEFAULT_SPAWN_CHANNEL_POLICY;
  const channelPolicy =
    manifestSpawn?.channels !== undefined
      ? applyChannelCeiling(manifestSpawn.channels, runtimeChannelPolicy)
      : runtimeChannelPolicy;
  if (channelPolicy.mode !== "none") {
    const parentChannels = options.parentAgent.query("channel:");
    for (const [tokenKey, channel] of parentChannels) {
      const tokenStr = tokenKey as string;
      const channelName = tokenStr.slice("channel:".length);
      const capturedChannel = channel as ChannelAdapter;
      // Create the proxy inside attach() so the child's own PID is used for attribution.
      // The child PID is only known after createKoi() assembles the agent; attach() is
      // called during that assembly, making agent.pid the correct child identity.
      const channelProvider: ComponentProvider = {
        name: `inherited-channel:${channelName}`,
        attach: async (agent) =>
          new Map([
            [
              channelToken(channelName) as string,
              createInheritedChannel(capturedChannel, agent.pid, channelPolicy),
            ],
          ]),
      };
      inheritanceProviders.push(channelProvider);
    }
  }

  // 5. Create AbortController for child signal/terminate support
  const abortController = new AbortController();

  // 6. Resolve priority
  const childPriority = inheritance.priority ?? 10;

  // 7. Build additional middleware for child-specific constraints
  const childMiddleware = [...(options.middleware ?? [])];
  if (options.requiredOutputTool !== undefined) {
    childMiddleware.push(
      createStructuredOutputGuard({ requiredToolName: options.requiredOutputTool }),
    );
  }

  // 8. Delegate to createKoi with child-specific options.
  //    Apply selfCeiling filter to raw providers: any tool:* component whose name is not
  //    in the selfCeiling must be stripped, otherwise a privileged caller could bypass the
  //    ceiling by passing an extra provider instead of going through additionalTools.
  const rawProviders = options.providers ?? [];
  const selfCeilingFilteredProviders: ComponentProvider[] =
    selfCeilingSet !== undefined
      ? rawProviders.map(
          (p): ComponentProvider => ({
            name: p.name,
            priority: p.priority,
            attach: async (agent) => {
              const result = await p.attach(agent);
              // AttachResult and ReadonlyMap both expose iteration via entries.
              // Strip tool:* keys that exceed the selfCeiling — same filter as
              // additionalTools above, but applied to provider-injected components.
              const raw: ReadonlyMap<string, unknown> = isAttachResult(result)
                ? result.components
                : result;
              const filtered = new Map<string, unknown>();
              for (const [key, val] of raw) {
                if (key.startsWith("tool:") && !selfCeilingSet.has(key.slice(5))) {
                  continue; // drop tool not in selfCeiling
                }
                filtered.set(key, val);
              }
              if (isAttachResult(result)) {
                return { components: filtered, skipped: result.skipped };
              }
              return filtered;
            },
            ...(p.detach !== undefined ? { detach: p.detach } : {}),
          }),
        )
      : rawProviders;
  let childRuntime: KoiRuntime;
  try {
    childRuntime = await createKoi({
      manifest: options.manifest,
      adapter: options.adapter,
      parentPid: options.parentAgent.pid,
      providers: [inheritedProvider, ...inheritanceProviders, ...selfCeilingFilteredProviders],
      spawnLedger: options.spawnLedger,
      spawn: options.spawnPolicy,
      ...(childMiddleware.length > 0 ? { middleware: childMiddleware } : {}),
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

        // Revoke auto-delegation grant on child termination.
        // Failure is logged as a structured warning with enough context to manually
        // revoke the leaked key. Future: retry queue (#1425 follow-up).
        if (childGrantId !== undefined && parentHasDelegation) {
          const parentDel = options.parentAgent.component<DelegationComponent>(DELEGATION);
          if (parentDel !== undefined) {
            void Promise.resolve(parentDel.revoke(childGrantId, false)).catch((err: unknown) => {
              console.warn(
                `[spawn-child] delegation revoke failed — key may remain active until manually revoked. ` +
                  `delegationId="${childGrantId}", childId="${childPid.id}", error: ${err instanceof Error ? err.message : String(err)}`,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fork helpers (Decision 1-A / 3-A / 14-A)
// ---------------------------------------------------------------------------

/**
 * Tool name unconditionally stripped from fork children.
 * Prevents recursive forks — a fork child should never itself fork.
 * Stripping at the denylist level is a type-level guarantee independent of
 * system prompt instructions or manifest configuration.
 */
const FORK_RECURSION_GUARD_TOOL = "Spawn";

/**
 * Strips `agent_spawn` from the denylist when `isFork` is true.
 * Pure function — safe to call in parallel child assembly.
 *
 * @internal exported for unit testing
 */
export function applyForkDenylist(base: ReadonlySet<string>, isFork: boolean): ReadonlySet<string> {
  if (!isFork) return base;
  const extended = new Set(base);
  extended.add(FORK_RECURSION_GUARD_TOOL);
  return extended;
}

/**
 * Applies the default fork `maxTurns` cap when `isFork` is true and `maxTurns` is
 * not explicitly set. Prevents runaway fork children from holding ledger slots.
 *
 * @internal exported for unit testing
 */
export function applyForkMaxTurns(
  maxTurns: number | undefined,
  isFork: boolean,
): number | undefined {
  if (!isFork) return maxTurns;
  return maxTurns ?? DEFAULT_FORK_MAX_TURNS;
}

/** Tool names stripped from nonInteractive agents to prevent user-facing prompts. */
const NON_INTERACTIVE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "AskUser",
  "AskUserQuestion",
  "ask-user",
  "ask_user",
]);

/**
 * Tool names always excluded from child tool inheritance.
 * The Spawn tool carries a closure bound to the parent agent entity; if a child
 * inherited it, nested spawn calls would be attributed to the ancestor rather than
 * the actual spawning agent (wrong lineage, wrong inbox/report routing, wrong depth).
 * Each child that needs Spawn must have a fresh provider attached during assembly.
 */
const ALWAYS_EXCLUDED_FROM_INHERITANCE: ReadonlySet<string> = new Set(["Spawn"]);

/** Always exclude certain tools from child inheritance. */
function expandDenylistWithAlwaysExcluded(
  base: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const merged = new Set(base ?? []);
  for (const tool of ALWAYS_EXCLUDED_FROM_INHERITANCE) {
    merged.add(tool);
  }
  return merged;
}

/** Remove denied tool names from an allowlist. Returns a new Set. */
function stripFromAllowlist(
  allowlist: ReadonlySet<string>,
  denied: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set(allowlist);
  for (const tool of denied) {
    result.delete(tool);
  }
  return result;
}

/** Expand a tool denylist with interactive tool names for nonInteractive agents. */
function expandDenylistForNonInteractive(
  base: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const merged = new Set(base ?? []);
  for (const tool of NON_INTERACTIVE_DENIED_TOOLS) {
    merged.add(tool);
  }
  return merged;
}

/**
 * Apply the manifest's channel ceiling to the runtime channel policy.
 * All three fields are clamped — the runtime can only be equally or more restrictive.
 *
 * Restrictiveness orders:
 *   mode:             none > output-only > all
 *   attribution:      none > prefix > metadata  (less attribution = more restrictive)
 *   propagateStatus:  false > true              (no propagation = more restrictive)
 */
function applyChannelCeiling(
  ceiling: SpawnChannelPolicy,
  runtime: SpawnChannelPolicy,
): SpawnChannelPolicy {
  const MODE_R: Record<ChannelInheritMode, number> = { none: 2, "output-only": 1, all: 0 };
  const ATTR_R: Record<"metadata" | "prefix" | "none", number> = {
    none: 2,
    prefix: 1,
    metadata: 0,
  };

  const effectiveMode = MODE_R[ceiling.mode] >= MODE_R[runtime.mode] ? ceiling.mode : runtime.mode;

  // Attribution: clamp to ceiling if ceiling is more restrictive
  let effectiveAttribution = runtime.attribution;
  if (ceiling.attribution !== undefined) {
    const ceilingR = ATTR_R[ceiling.attribution];
    const runtimeR = runtime.attribution !== undefined ? ATTR_R[runtime.attribution] : -1;
    effectiveAttribution = ceilingR >= runtimeR ? ceiling.attribution : runtime.attribution;
  }

  // propagateStatus: false is more restrictive — ceiling false cannot be overridden
  const effectivePropagateStatus =
    ceiling.propagateStatus === false ? false : runtime.propagateStatus;

  return {
    mode: effectiveMode,
    ...(effectiveAttribution !== undefined ? { attribution: effectiveAttribution } : {}),
    ...(effectivePropagateStatus !== undefined
      ? { propagateStatus: effectivePropagateStatus }
      : {}),
  };
}

/** Returns a new Set containing only elements present in both sets. */
function intersectSets<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): ReadonlySet<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

/** Returns a new Set containing all elements from both sets. */
function unionSets<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): ReadonlySet<T> {
  const result = new Set<T>(a);
  for (const item of b) result.add(item);
  return result;
}
