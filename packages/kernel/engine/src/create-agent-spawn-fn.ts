/**
 * createAgentSpawnFn — SpawnFn that resolves agents via AgentResolver and spawns in-process.
 *
 * This is the main deliverable for #1424: the glue between L2 agent definitions
 * and L1 spawn machinery. Resolves agent type → AgentDefinition → manifest,
 * injects systemPrompt, and delegates to runSpawnedAgent for lifecycle.
 *
 * Layer: L1 (depends on L0 interfaces only — AgentResolver is L0, implementation is L2)
 */

import type {
  AgentManifest,
  AgentResolver,
  ComponentProvider,
  EngineAdapter,
  EngineInput,
  InboxItem,
  KoiMiddleware,
  ReportStore,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
  TaskableAgent,
} from "@koi/core";
import { INBOX, validateSpawnRequest } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { runWithAgentContext } from "@koi/execution-context";

import { applyDeliveryPolicy, resolveDeliveryPolicy } from "./delivery-policy.js";
import { createTextCollector } from "./output-collector.js";
import { createSystemPromptMiddleware, runSpawnedAgent } from "./run-spawned-agent.js";
import { applyForkMaxTurns, spawnChildAgent } from "./spawn-child.js";
import type { SpawnChildOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Options for creating an agent-resolution SpawnFn. */
export interface CreateAgentSpawnFnOptions {
  /** Agent resolver for definition lookup (L0 interface, L2 implementation). */
  readonly resolver: AgentResolver;
  /**
   * Base spawn options shared across all agent spawns.
   * Must include parentAgent, spawnLedger, spawnPolicy.
   */
  readonly base: Omit<
    SpawnChildOptions,
    | "manifest"
    | "adapter"
    | "toolDenylist"
    | "additionalTools"
    | "nonInteractive"
    | "requiredOutputTool"
    | "limits"
    | "providers"
    | "middleware"
    | "signal"
  >;
  /** Engine adapter for child agent loops. */
  readonly adapter: EngineAdapter;
  /** Base manifest template — merged with resolved definition. */
  readonly manifestTemplate: AgentManifest;
  /** Inherited middleware (observe-phase: tracing, telemetry). */
  readonly inheritedMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * Optional async factory invoked once per spawned child to
   * produce fresh middleware instances for that child. Used by
   * hosts that resolve manifest-declared middleware so each child
   * gets its own middleware state (its own audit queue, its own
   * lifecycle hooks) rather than sharing mutable parent state.
   *
   * The resulting middleware is appended to the inherited chain
   * before `systemPrompt` is injected. Return an empty array when
   * there is nothing to add.
   */
  readonly perChildMiddlewareFactory?:
    | ((childCtx: {
        readonly parentSessionId: string;
        readonly parentAgentId: string;
      }) => Promise<readonly KoiMiddleware[]>)
    | undefined;
  /**
   * ReportStore for on_demand delivery. Required when spawning agents with
   * `delivery.kind === "on_demand"` — fail-fast if absent to prevent silent drops.
   */
  readonly reportStore?: ReportStore | undefined;
  /**
   * Factory for creating fresh spawn tool providers for child agents.
   * When provided, each spawned child gets a new `Spawn` tool bound to itself
   * so nested delegation works correctly. Pass this from `createSpawnToolProvider`
   * to enable recursive delegation without a circular import.
   *
   * Example (inside createSpawnToolProvider's attach()):
   *   spawnProviderFactory: () => createSpawnToolProvider(config)
   */
  readonly spawnProviderFactory?: (() => ComponentProvider) | undefined;
  /**
   * When true, unknown agent names (NOT_FOUND from resolver) create ad-hoc
   * agents using manifestTemplate + description as system prompt. When false
   * (default), NOT_FOUND is a hard error — fail-closed semantics.
   *
   * Enable for Claude Code-style dynamic agent creation where the model
   * invents agent names on the fly.
   */
  readonly allowDynamicAgents?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SpawnFn that resolves agents via AgentResolver and spawns them in-process.
 *
 * Flow:
 * 1. Resolve agentName → TaskableAgent (AgentDefinition) via resolver
 * 2. Build manifest from template + definition
 * 3. Inject systemPrompt from definition (if present)
 * 4. Build SpawnChildOptions from SpawnRequest constraints
 * 5. Delegate to runSpawnedAgent for lifecycle
 * 6. Wrap in AgentExecutionContext for identity isolation
 */
export function createAgentSpawnFn(options: CreateAgentSpawnFnOptions): SpawnFn {
  const {
    resolver,
    base,
    adapter,
    manifestTemplate,
    inheritedMiddleware,
    allowDynamicAgents,
    perChildMiddlewareFactory,
  } = options;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    // Issue 16: fast-path for already-expired deadlines. If the caller set an absolute
    // deadline and it has already passed (e.g. request was queued and delayed), fail
    // immediately before doing any resolution or assembly work.
    if (request.absoluteDeadlineMs !== undefined && request.absoluteDeadlineMs <= Date.now()) {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Spawn request for "${request.agentName}" was rejected: absoluteDeadlineMs (${request.absoluteDeadlineMs}) has already elapsed.`,
          retryable: false,
        },
      };
    }

    // Capture absolute deadline immediately so setup time (slot acquisition, assembly)
    // is deducted from the child's budget regardless of the delivery mode.
    // Callers that already set absoluteDeadlineMs (e.g. the Spawn tool) are respected;
    // callers that only set timeoutMs get the same guarantee via this fallback.
    const effectiveDeadlineMs: number | undefined =
      request.absoluteDeadlineMs ??
      (request.timeoutMs !== undefined && request.timeoutMs > 0
        ? Date.now() + request.timeoutMs
        : undefined);

    // 1. Resolve agent definition (or use inline manifest)
    let manifest: AgentManifest;
    let systemPrompt: string | undefined = request.systemPrompt;

    if (request.manifest !== undefined) {
      // Inline manifest provided — skip resolution but still apply permission guard below
      manifest = request.manifest;
    } else {
      const resolveResult = await resolver.resolve(request.agentName);
      if (
        !resolveResult.ok &&
        resolveResult.error.code === "NOT_FOUND" &&
        allowDynamicAgents === true
      ) {
        // Dynamic agent creation (opt-in): when the name doesn't match any
        // registered definition and allowDynamicAgents is explicitly enabled,
        // create an ad-hoc agent from the manifestTemplate + description.
        // Other resolver errors (PERMISSION, VALIDATION, etc.) and non-opt-in
        // NOT_FOUND are preserved as hard failures (fail-closed).
        manifest = {
          ...manifestTemplate,
          name: request.agentName,
          description: request.description,
        };
        // Use description as system prompt if none explicitly provided
        if (systemPrompt === undefined) {
          systemPrompt = request.description;
        }
      } else if (!resolveResult.ok) {
        // Non-NOT_FOUND resolver errors: fail closed (preserve existing behavior)
        return { ok: false, error: resolveResult.error };
      } else {
        const definition = resolveResult.value;

        // 2. Build manifest: template provides infrastructure defaults (channels, middleware stack),
        //    definition.manifest overrides with agent-specific controls (permissions, delegation,
        //    sandbox, delivery, lifecycle, tools, etc.). Selective-copy was wrong: it silently
        //    dropped security and isolation fields defined on the resolved agent.
        //
        //    The `spawn` field is deep-merged so that template-level env/channel ceilings
        //    (e.g. spawn.env.exclude for credential isolation) are NOT dropped when the
        //    resolved definition specifies spawn.tools without its own spawn.env or channels.
        const mergedSpawn =
          manifestTemplate?.spawn !== undefined || definition.manifest.spawn !== undefined
            ? {
                ...manifestTemplate?.spawn,
                ...definition.manifest.spawn,
              }
            : undefined;
        manifest = {
          ...manifestTemplate,
          ...definition.manifest,
          ...(mergedSpawn !== undefined ? { spawn: mergedSpawn } : {}),
        };

        // 3. Use definition's systemPrompt if request didn't provide one
        if (systemPrompt === undefined) {
          systemPrompt = extractSystemPrompt(definition);
        }
      }
    }

    // 2b. Capability attenuation guard — applied to ALL paths (resolver + inline).
    //     A parent cannot confer permissions it doesn't hold. Validate that the child
    //     manifest's permission set is not broader than the parent's effective permissions.
    const permissionError = checkPermissionSubset(
      base.parentAgent.manifest.permissions,
      manifest.permissions,
      manifest.name,
    );
    if (permissionError !== undefined) {
      return { ok: false, error: permissionError };
    }

    // 3b. additionalTools ceiling guard — Issue 1.
    //     A parent cannot inject tools into a child that the parent itself does not hold.
    //     This enforces the invariant: children can only receive a subset of parent capabilities.
    //     (Open Security Architecture SP-047: privilege cannot accumulate through delegation chains.)
    if (request.additionalTools !== undefined && request.additionalTools.length > 0) {
      const parentToolNames = new Set<string>();
      for (const [token] of base.parentAgent.query<import("@koi/core").Tool>("tool:")) {
        const tokenStr = token as string;
        parentToolNames.add(tokenStr.slice("tool:".length));
      }
      const unknownTools = request.additionalTools.filter(
        (desc) => !parentToolNames.has(desc.name),
      );
      if (unknownTools.length > 0) {
        return {
          ok: false,
          error: {
            code: "PERMISSION",
            message:
              `Cannot spawn "${request.agentName}": additionalTools contains tool(s) not registered ` +
              `on the parent agent — a parent cannot confer capabilities it does not hold. ` +
              `Unknown tool(s): ${unknownTools.map((t) => t.name).join(", ")}. ` +
              `Register the tool on the parent first, or remove it from additionalTools.`,
            retryable: false,
          },
        };
      }
    }

    // 4. Build middleware: inherited + per-child freshly-resolved + system prompt injection
    const childMiddleware: KoiMiddleware[] = [...(inheritedMiddleware ?? [])];
    if (perChildMiddlewareFactory !== undefined) {
      const perChildMiddleware = await perChildMiddlewareFactory({
        parentSessionId: base.parentAgent.manifest.name,
        parentAgentId: base.parentAgent.pid.id,
      });
      childMiddleware.push(...perChildMiddleware);
    }
    if (systemPrompt !== undefined) {
      childMiddleware.push(createSystemPromptMiddleware(systemPrompt));
    }

    // 5. Map SpawnRequest constraint fields to SpawnChildOptions.
    //    Attach a fresh Spawn provider for the child only when ALL of the following hold:
    //      a) The parent manifest's spawn ceiling allows Spawn for children
    //      b) The child is not a fork (fork recursion guard — forks never delegate further)
    //      c) The child manifest's selfCeiling includes "Spawn" (or declares no ceiling)
    //    The selfCeiling check ensures built-ins like coordinator can't receive Spawn from a
    //    privileged parent even if (a) and (b) would otherwise allow it.
    const isFork = request.fork === true;
    const spawnAllowedByManifest = isSpawnAllowedByManifest(
      base.parentAgent.manifest.spawn,
      request.toolDenylist,
      request.toolAllowlist,
    );
    const childSelfCeilingTools = manifest.selfCeiling?.tools;
    const selfCeilingAllowsSpawn =
      childSelfCeilingTools === undefined || childSelfCeilingTools.includes("Spawn");
    const childProviders: ComponentProvider[] =
      options.spawnProviderFactory !== undefined &&
      spawnAllowedByManifest &&
      !isFork &&
      selfCeilingAllowsSpawn
        ? [options.spawnProviderFactory()]
        : [];

    // Fail fast on conflicting list fields before building child options.
    const validation = validateSpawnRequest(request);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    // Apply DEFAULT_FORK_MAX_TURNS when fork=true and maxTurns not explicitly set.
    const effectiveMaxTurns = applyForkMaxTurns(request.maxTurns, isFork);

    const spawnOptions: SpawnChildOptions = {
      ...base,
      manifest,
      adapter,
      signal: request.signal,
      ...(isFork ? { fork: true as const } : {}),
      ...(childProviders.length > 0 ? { providers: childProviders } : {}),
      ...(request.toolDenylist !== undefined ? { toolDenylist: request.toolDenylist } : {}),
      ...(request.toolAllowlist !== undefined ? { toolAllowlist: request.toolAllowlist } : {}),
      ...(request.additionalTools !== undefined
        ? { additionalTools: request.additionalTools }
        : {}),
      ...(request.nonInteractive !== undefined ? { nonInteractive: request.nonInteractive } : {}),
      ...(childMiddleware.length > 0 ? { middleware: childMiddleware } : {}),
      limits: {
        ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      },
    };

    // 6. Resolve delivery policy: request override > base default > manifest > streaming
    const policy = resolveDeliveryPolicy(request.delivery ?? base.delivery, manifest.delivery);

    // 7. Wrap in agent context for identity isolation
    const agentContext = {
      agentId: request.agentId ?? `spawn-${manifest.name}-${Date.now()}`,
      sessionId: `session-${manifest.name}-${Date.now()}`,
      parentAgentId: base.parentAgent.pid.id,
    };

    // 8a. Non-streaming delivery (deferred / on_demand): spawn child and fire-and-forget.
    //     The real output flows to the parent's inbox or ReportStore per policy.
    //     Return immediately — the SpawnResult output will be empty for async delivery.
    if (policy.kind !== "streaming") {
      // Fail fast: non-streaming delivery requires a sink for the result.
      // on_demand needs a ReportStore; deferred needs the parent inbox.
      // Without the appropriate sink the child runs but output is silently lost.
      if (policy.kind === "on_demand" && options.reportStore === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "on_demand delivery requires a ReportStore — provide it via CreateAgentSpawnFnOptions.reportStore",
            retryable: false,
          },
        };
      }
      if (policy.kind === "deferred" && base.parentAgent.component(INBOX) === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "deferred delivery requires a parent inbox — the parent agent must have an INBOX component",
            retryable: false,
          },
        };
      }
      return runWithAgentContext(agentContext, async (): Promise<SpawnResult> => {
        // Wrap spawnChildAgent() so slot-acquisition, governance, assembly, and
        // cancellation failures all return SpawnResult instead of throwing.
        // This matches the contract of runSpawnedAgent() used in the streaming path.
        let spawnResult: Awaited<ReturnType<typeof spawnChildAgent>>;
        try {
          spawnResult = await spawnChildAgent(spawnOptions);
        } catch (e: unknown) {
          if (e instanceof KoiRuntimeError) {
            return { ok: false, error: e.toKoiError() };
          }
          const message = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            error: { code: "INTERNAL", message: `Spawn failed: ${message}`, retryable: false },
          };
        }
        const parentInbox = base.parentAgent.component(INBOX);
        const deliveryHandle = applyDeliveryPolicy({
          spawnResult,
          policy,
          ...(parentInbox !== undefined ? { parentInbox } : {}),
          ...(options.reportStore !== undefined ? { reportStore: options.reportStore } : {}),
          parentAgentId: base.parentAgent.pid.id,
        });
        // Use a child-owned signal for background delivery — decoupling the child
        // lifetime from the parent tool call. request.signal (which may fire when
        // the Spawn tool call times out or the parent cancels) must NOT interrupt a
        // deferred/on_demand child that is supposed to outlive the tool invocation.
        // However, the wall-clock deadline IS honored. Use absoluteDeadlineMs (set at
        // call time) to compute remaining budget rather than starting a fresh full-duration
        // timer here — this prevents giving the child a double budget for setup overhead.
        const childController = new AbortController();
        let childSignal = childController.signal;
        // Use effectiveDeadlineMs (captured at request start) so elapsed setup time
        // (slot wait, assembly) is deducted from the remaining budget.
        if (effectiveDeadlineMs !== undefined) {
          const remainingMs = effectiveDeadlineMs - Date.now();
          if (remainingMs <= 0) {
            // Deadline already elapsed during setup — abort immediately
            childController.abort();
          } else {
            childSignal = AbortSignal.any([
              childController.signal,
              AbortSignal.timeout(remainingMs),
            ]);
          }
        }
        const input: EngineInput = {
          kind: "text",
          text: request.description,
          signal: childSignal,
        };
        void (async (): Promise<void> => {
          try {
            await deliveryHandle.runChild?.(input);
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error(
              `[agent-spawn] ${policy.kind} delivery failed for "${manifest.name}"`,
              err,
            );
            // Propagate delivery failure to parent inbox so the caller can observe it
            // instead of silently discarding the error. The item mode "collect" allows
            // the parent to inspect it at its next turn boundary.
            if (parentInbox !== undefined) {
              const errorItem: InboxItem = {
                id: `delivery-error-${spawnResult.childPid.id}-${Date.now()}`,
                from: spawnResult.childPid.id,
                mode: "collect",
                content: `[delivery-error] agent "${manifest.name}" (${policy.kind}): ${errorMessage}`,
                priority: 0,
                createdAt: Date.now(),
              };
              const errorAccepted = parentInbox.push(errorItem);
              if (!errorAccepted) {
                // The inbox is saturated — both the child output AND the error notification
                // were lost. Log at error level so this shows up in monitoring even without
                // an inbox observer. There is no other durable channel to write to here.
                console.error(
                  `[agent-spawn] UNRECOVERABLE: parent inbox full — child output AND error notification lost for agent "${manifest.name}" (child: ${spawnResult.childPid.id}). Original error: ${errorMessage}`,
                );
              }
            }
            // For on_demand: write a minimal error RunReport under the same session key
            // so callers querying reportStore.getBySession(sessionId("delivery-<childId>"))
            // can distinguish a failed job from a pending/missing one.
            if (policy.kind === "on_demand" && options.reportStore !== undefined) {
              const childId = spawnResult.childPid.id;
              void Promise.resolve(
                options.reportStore.put({
                  agentId: childId,
                  sessionId: `delivery-${childId}` as ReturnType<
                    typeof import("@koi/core").sessionId
                  >,
                  runId: `delivery-${childId}-error-${Date.now()}` as ReturnType<
                    typeof import("@koi/core").runId
                  >,
                  summary: `[FAILED] ${errorMessage}`,
                  duration: {
                    startedAt: Date.now(),
                    completedAt: Date.now(),
                    durationMs: 0,
                    totalTurns: 0,
                    totalActions: 0,
                    truncated: false,
                  },
                  actions: [],
                  artifacts: [],
                  issues: [
                    { severity: "critical", message: errorMessage, turnIndex: 0, resolved: false },
                  ],
                  cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
                  recommendations: [],
                }),
              ).catch((storeErr: unknown) => {
                console.error(
                  `[agent-spawn] failed to write error report for child "${childId}"`,
                  storeErr,
                );
              });
            }
          } finally {
            spawnResult.handle.terminate();
            await spawnResult.handle.waitForCompletion();
            await spawnResult.runtime.dispose();
          }
        })();
        // Return the child ID so callers can retrieve on_demand reports.
        // on_demand stores reports under sessionId("delivery-<childId>") —
        // callers can reconstruct the lookup key from this ID.
        // deferred callers receive the result via inbox; output is intentionally empty.
        const childId = spawnResult.childPid.id;
        const output =
          policy.kind === "on_demand" ? JSON.stringify({ delivery: "on_demand", childId }) : "";
        return { ok: true, output };
      });
    }

    // 8b. Streaming (default): run synchronously, collect output inline.
    // Compose the deadline into the streaming signal too — same wall-clock budget
    // applies regardless of delivery mode.
    const streamingSignal =
      effectiveDeadlineMs !== undefined
        ? AbortSignal.any([
            request.signal,
            AbortSignal.timeout(Math.max(0, effectiveDeadlineMs - Date.now())),
          ])
        : request.signal;
    return runWithAgentContext(agentContext, () =>
      runSpawnedAgent({
        spawnOptions,
        input: { kind: "text", text: request.description, signal: streamingSignal },
        collector: createTextCollector(),
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the effective tool ceiling allows the child to use Spawn.
 * Checks manifest allowlist/denylist and per-request allowlist/denylist.
 * When false, the spawnProviderFactory is not called — the child cannot delegate further.
 */
function isSpawnAllowedByManifest(
  manifestSpawn: AgentManifest["spawn"],
  requestDenylist: readonly string[] | undefined,
  requestAllowlist: readonly string[] | undefined,
): boolean {
  // Runtime denylist explicitly blocks Spawn
  if (requestDenylist?.includes("Spawn")) return false;

  // Runtime allowlist present but doesn't include Spawn
  if (requestAllowlist !== undefined && !requestAllowlist.includes("Spawn")) return false;

  // Manifest denylist blocks Spawn
  if (manifestSpawn?.tools?.policy === "denylist" && manifestSpawn.tools.list?.includes("Spawn")) {
    return false;
  }

  // Manifest allowlist doesn't include Spawn
  if (
    manifestSpawn?.tools?.policy === "allowlist" &&
    !manifestSpawn.tools.list?.includes("Spawn")
  ) {
    return false;
  }

  return true;
}

/**
 * Extract systemPrompt from a TaskableAgent if it has one.
 * AgentDefinition extends TaskableAgent with an optional systemPrompt field.
 */
function extractSystemPrompt(agent: TaskableAgent): string | undefined {
  return (agent as { readonly systemPrompt?: string }).systemPrompt;
}

/**
 * Validate that the child's permission set is not broader than the parent's.
 * Returns a KoiError if the child would have broader permissions, undefined if safe.
 *
 * Rules:
 * - Child has permissions, parent has none → reject (parent cannot confer what it lacks)
 * - Child's allow-list contains entries not in parent's allow-list → reject
 * - Child's deny-list is a proper subset of parent's deny-list (removing denies) → reject
 */
function checkPermissionSubset(
  parentPerms: AgentManifest["permissions"],
  childPerms: AgentManifest["permissions"],
  childName: string,
):
  | { readonly code: "PERMISSION"; readonly message: string; readonly retryable: false }
  | undefined {
  // Normalize both sides to {} so we apply canonical rules regardless of whether
  // the child omits `permissions` entirely — an omitted child permissions block
  // must NOT erase parent deny-list entries.
  const normalizedParent = parentPerms ?? {};
  const normalizedChild = childPerms ?? {};

  // If parent has no restrictions at all, child cannot be broader — nothing to check.
  if (parentPerms === undefined && childPerms === undefined) return undefined;

  // Parent has no permissions, child has some — parent cannot confer what it lacks.
  if (parentPerms === undefined && childPerms !== undefined) {
    return {
      code: "PERMISSION",
      message: `Cannot spawn "${childName}": child declares permissions but parent has none — parent cannot confer capabilities it does not possess.`,
      retryable: false,
    };
  }

  // Check deny-list first: parent denies must be monotonically preserved in child.
  // An omitted child deny (normalizedChild.deny === undefined) means no denies, which
  // removes all parent denies — that is a violation.
  if (normalizedParent.deny !== undefined && normalizedParent.deny.length > 0) {
    const childDenied = new Set(normalizedChild.deny ?? []);
    const removedDenies = normalizedParent.deny.filter((t) => !childDenied.has(t));
    if (removedDenies.length > 0) {
      return {
        code: "PERMISSION",
        message: `Cannot spawn "${childName}": child removes deny-list entries that parent enforces: ${removedDenies.join(", ")}`,
        retryable: false,
      };
    }
  }

  // Check allow-list: child must not allow tools the parent doesn't allow.
  // Honor wildcard: a parent with allow: ["*"] permits any child allow-list.
  if (normalizedChild.allow !== undefined && normalizedChild.allow.length > 0) {
    const parentAllowed = new Set(normalizedParent.allow ?? []);
    if (!parentAllowed.has("*")) {
      const extraAllowed = normalizedChild.allow.filter((t) => !parentAllowed.has(t) && t !== "*");
      if (extraAllowed.length > 0) {
        return {
          code: "PERMISSION",
          message: `Cannot spawn "${childName}": child allow-list contains tools not permitted by parent: ${extraAllowed.join(", ")}`,
          retryable: false,
        };
      }
    }
  }

  return undefined;
}
