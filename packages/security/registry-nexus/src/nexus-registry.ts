/**
 * Nexus-backed AgentRegistry implementation.
 *
 * Uses Nexus as the authoritative store for agent state. Maintains a local
 * in-memory projection for fast reads, synchronized via periodic polling.
 * Watch events are emitted both from local mutations and from poll-detected
 * remote changes.
 *
 * Dual-generation model: Koi generation (CAS for callers) is tracked in the
 * local projection. Nexus generation (CAS for server) is tracked separately
 * in `nexusGens` and used for Nexus RPC calls.
 */

import type {
  AgentId,
  AgentRegistry,
  AgentStatus,
  KoiError,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
  VisibilityContext,
} from "@koi/core";
import { agentGroupId, agentId, matchesFilter, VALID_TRANSITIONS, zoneId } from "@koi/core";
import { createListenerSet } from "@koi/event-delivery";
import type { NexusRegistryConfig } from "./config.js";
import { DEFAULT_NEXUS_REGISTRY_CONFIG, validateNexusRegistryConfig } from "./config.js";
import type { NexusAgent } from "./nexus-rpc.js";
import {
  nexusDeleteAgent,
  nexusGetAgent,
  nexusListAgents,
  nexusRegisterAgent,
  nexusTransition,
  nexusUpdateMetadata,
} from "./nexus-rpc.js";
import { decodeKoiStatus, encodeKoiStatus, mapKoiToNexus, mapNexusToKoi } from "./state-mapping.js";

/**
 * Metadata keys owned by the registry adapter. Callers must not overwrite
 * these via patch() — they encode lifecycle and identity that the adapter
 * treats as authoritative when re-hydrating from Nexus, and accepting
 * caller writes would let `metadata.koi:terminated = true` (or a forged
 * agentType/parentId/etc.) cross the user-data → registry-state trust
 * boundary on the next refetch.
 */
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "koi:status",
  "koi:terminated",
  "agentType",
  "registeredAt",
  "priority",
  "parentId",
  "spawner",
  "groupId",
  "zoneId",
]);

function mapNexusAgentToEntry(agent: NexusAgent): RegistryEntry {
  const metadata = agent.metadata ?? {};
  const koiStatus = decodeKoiStatus(metadata);
  const remotePhase = mapNexusToKoi(agent.state, metadata);

  // Trust koi:status only when its phase agrees with the authoritative
  // Nexus state. After a partial-failure path (agent_transition committed,
  // update_agent_metadata failed), Nexus has advanced but the metadata
  // blob is stale — falling back to the live state prevents phase rollback
  // on the next poll.
  //
  // Special case: Nexus `SUSPENDED` is lossy — both Koi `suspended` and
  // `terminated` map to it. The phase comparison alone is not enough to
  // detect a stale metadata blob, since (e.g.) a stale `phase: "suspended"`
  // matches the lossy decode of a remote `terminated` agent. Require that
  // metadata.koi:terminated explicitly match the encoded phase before
  // trusting the blob in this ambiguous case.
  const remoteIsAmbiguousSuspended = agent.state === "SUSPENDED";
  const terminatedFlag = metadata["koi:terminated"] === true;
  const ambiguityResolved =
    !remoteIsAmbiguousSuspended ||
    (koiStatus?.phase === "terminated" && terminatedFlag) ||
    (koiStatus?.phase === "suspended" && !terminatedFlag);

  const trustedKoiStatus =
    koiStatus !== undefined && koiStatus.phase === remotePhase && ambiguityResolved
      ? koiStatus
      : undefined;

  const status: AgentStatus = trustedKoiStatus ?? {
    phase: remotePhase,
    generation: agent.generation ?? 0,
    conditions: [],
    lastTransitionAt: Date.now(),
  };

  const parentId = typeof metadata.parentId === "string" ? agentId(metadata.parentId) : undefined;
  const spawner = typeof metadata.spawner === "string" ? agentId(metadata.spawner) : undefined;
  const groupIdValue =
    typeof metadata.groupId === "string" ? agentGroupId(metadata.groupId) : undefined;
  const zoneIdValue =
    typeof agent.zone_id === "string"
      ? zoneId(agent.zone_id)
      : typeof metadata.zoneId === "string"
        ? zoneId(metadata.zoneId)
        : undefined;

  return {
    agentId: agentId(agent.agent_id),
    status,
    agentType: (metadata.agentType as "copilot" | "worker") ?? "worker",
    metadata,
    registeredAt: (metadata.registeredAt as number) ?? Date.now(),
    priority: (metadata.priority as number) ?? 10,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(spawner !== undefined ? { spawner } : {}),
    ...(groupIdValue !== undefined ? { groupId: groupIdValue } : {}),
    ...(zoneIdValue !== undefined ? { zoneId: zoneIdValue } : {}),
  };
}

/**
 * Create a Nexus-backed AgentRegistry.
 *
 * Performs eager warmup by listing all agents from Nexus at startup.
 * Starts a poll timer to keep the local projection in sync.
 */
export async function createNexusRegistry(config: NexusRegistryConfig): Promise<AgentRegistry> {
  const validation = validateNexusRegistryConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message, { cause: validation.error });
  }

  const transport = config.transport;
  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs;
  const startupTimeoutMs =
    config.startupTimeoutMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.startupTimeoutMs;

  const projection = new Map<AgentId, RegistryEntry>();
  /** Nexus-side generation per agent — separate from Koi generation. */
  const nexusGens = new Map<AgentId, number>();
  const listeners = createListenerSet<RegistryEvent>({
    onError: (err) =>
      console.warn("[registry-nexus] listener threw:", err instanceof Error ? err.message : err),
  });
  // let: self-scheduled poll handle (setTimeout). Used instead of
  // setInterval so polls cannot overlap — re-entrant polls can produce
  // split-brain deletions when an older slow poll completes after a
  // newer poll has already added a fresh agent.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  // let: in-flight guard belt-and-braces against bugs where dispose
  // races a tick boundary.
  let pollInFlight = false;
  // let: disposed flag to gate background work
  let disposed = false;
  // let: broken flag — set when poll detects an unrecoverable overflow
  // or repeated sync failures. Once broken, all operations throw rather
  // than returning a partial / stale mirror.
  let broken: string | undefined;
  // let: consecutive poll failures — used to fail closed before the
  // mirror becomes unboundedly stale.
  let consecutivePollFailures = 0;
  const MAX_POLL_FAILURES = 5;
  // Per-entry tombstones for agents whose phase is known to be stale
  // (transition committed remotely, reconciliation refetch failed). Reads
  // and mutating ops fail closed on these IDs until a successful refetch
  // resyncs the projection — phase-based scheduling/cleanup must not act
  // on a value the registry knows is wrong.
  const stale = new Set<AgentId>();
  // Per-agent poll hydration failures — a single agent that fails to
  // refetch repeatedly is tombstoned so callers don't read stale state.
  const perAgentGetFailures = new Map<AgentId, number>();
  const MAX_PER_AGENT_GET_FAILURES = 3;

  function assertHealthy(): void {
    if (broken !== undefined) {
      throw new Error(`registry-nexus is broken: ${broken}`);
    }
  }

  const notify = listeners.notify;

  async function loadProjection(): Promise<void> {
    const listResult = await nexusListAgents(transport, config.zoneId);
    if (!listResult.ok) {
      throw new Error(
        `Failed to load agents from Nexus during startup: ${listResult.error.message}`,
        {
          cause: listResult.error,
        },
      );
    }

    if (listResult.value.length > maxEntries) {
      throw new Error(
        `Nexus reports ${String(listResult.value.length)} agents but maxEntries=${String(maxEntries)}; refuse to start with a partial mirror`,
      );
    }

    projection.clear();
    nexusGens.clear();

    for (const nexusAgent of listResult.value) {
      const detail = await nexusGetAgent(transport, nexusAgent.agent_id);
      if (!detail.ok) {
        // Fail closed: starting up with a partial mirror would silently
        // hide live agents until poll happens to repair them.
        throw new Error(
          `Failed to hydrate agent ${nexusAgent.agent_id} during warmup: ${detail.error.message}`,
          { cause: detail.error },
        );
      }
      const entry = mapNexusAgentToEntry(detail.value);
      projection.set(entry.agentId, entry);
      nexusGens.set(entry.agentId, detail.value.generation ?? 0);
    }
  }

  function recordPollFailure(reason: string, err: KoiError): void {
    consecutivePollFailures += 1;
    console.warn(
      `[registry-nexus] poll failure (${String(consecutivePollFailures)}/${String(MAX_POLL_FAILURES)}): ${reason}: ${err.message}`,
    );
    if (consecutivePollFailures >= MAX_POLL_FAILURES) {
      broken = `poll failed ${String(MAX_POLL_FAILURES)} consecutive times — last error: ${err.message}`;
      console.error(`[registry-nexus] ${broken}`);
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    }
  }

  async function poll(): Promise<void> {
    if (disposed) return;

    const listResult = await nexusListAgents(transport, config.zoneId);
    if (!listResult.ok) {
      recordPollFailure("list_agents", listResult.error);
      return;
    }

    const remoteIds = new Set<string>();
    // let: tracks per-agent get_agent failures within this tick; one failure
    // doesn't trip the broken flag, but we still surface visibility.
    let perTickGetFailures = 0;

    for (const nexusAgent of listResult.value) {
      remoteIds.add(nexusAgent.agent_id);
      const id = agentId(nexusAgent.agent_id);
      const existing = projection.get(id);
      const remoteGen = nexusAgent.generation ?? 0;
      const localNexusGen = nexusGens.get(id) ?? -1;

      if (localNexusGen === remoteGen && existing !== undefined) continue;

      const detail = await nexusGetAgent(transport, nexusAgent.agent_id);
      if (!detail.ok) {
        perTickGetFailures += 1;
        const prev = perAgentGetFailures.get(id) ?? 0;
        const next = prev + 1;
        perAgentGetFailures.set(id, next);
        console.warn(
          `[registry-nexus] poll get_agent ${nexusAgent.agent_id} failed (${String(next)}/${String(MAX_PER_AGENT_GET_FAILURES)}): ${detail.error.message}`,
        );
        if (next >= MAX_PER_AGENT_GET_FAILURES) {
          // Tombstone this entry: persistent hydration failure means we
          // can't trust the local projection for this agent. Reads return
          // undefined; mutating ops reject; a later successful poll will
          // clear the tombstone.
          stale.add(id);
          console.error(
            `[registry-nexus] tombstoning ${nexusAgent.agent_id} after ${String(MAX_PER_AGENT_GET_FAILURES)} consecutive get_agent failures — reads will return undefined until refetch succeeds`,
          );
        }
        continue;
      }
      perAgentGetFailures.delete(id);

      if (projection.size >= maxEntries && existing === undefined) {
        // Fail closed: a partial mirror would silently hide live remote
        // agents from list()/lookup() forever. Mark broken so callers
        // see an error instead of an incomplete view.
        broken = `poll observed remote agent ${nexusAgent.agent_id} but projection is at capacity (${String(maxEntries)}); raise maxEntries or scale out`;
        console.error(`[registry-nexus] ${broken}`);
        if (pollTimer !== undefined) {
          clearTimeout(pollTimer);
          pollTimer = undefined;
        }
        return;
      }

      // mapNexusAgentToEntry throws on unknown Nexus state — treat that
      // as a per-agent hydration failure (tombstone after threshold)
      // rather than letting an uncaught throw kill the poll loop.
      let entry: RegistryEntry;
      try {
        entry = mapNexusAgentToEntry(detail.value);
      } catch (err) {
        const prev = perAgentGetFailures.get(id) ?? 0;
        perAgentGetFailures.set(id, prev + 1);
        console.warn(
          `[registry-nexus] failed to map Nexus agent ${nexusAgent.agent_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if ((perAgentGetFailures.get(id) ?? 0) >= MAX_PER_AGENT_GET_FAILURES) {
          stale.add(id);
        }
        continue;
      }
      projection.set(id, entry);
      nexusGens.set(id, detail.value.generation ?? 0);
      stale.delete(id);

      if (existing === undefined) {
        notify({ kind: "registered", entry });
      } else if (existing.status.phase !== entry.status.phase) {
        notify({
          kind: "transitioned",
          agentId: id,
          from: existing.status.phase,
          to: entry.status.phase,
          generation: entry.status.generation,
          reason: entry.status.reason ?? { kind: "assembly_complete" },
        });
      }
    }

    for (const [id] of projection) {
      if (!remoteIds.has(id)) {
        projection.delete(id);
        nexusGens.delete(id);
        stale.delete(id);
        perAgentGetFailures.delete(id);
        notify({ kind: "deregistered", agentId: id });
      }
    }

    if (perTickGetFailures === 0) {
      // List succeeded and every observed agent hydrated cleanly — reset
      // the rolling counter so transient blips don't add up.
      consecutivePollFailures = 0;
    } else if (perTickGetFailures > 0 && perTickGetFailures === listResult.value.length) {
      // Every per-agent fetch failed — treat as a list-equivalent failure.
      recordPollFailure("all get_agent calls failed", {
        code: "EXTERNAL",
        message: "all per-agent fetches failed",
        retryable: true,
      });
    }
  }

  async function register(entry: RegistryEntry): Promise<RegistryEntry> {
    assertHealthy();
    // Fail closed if the local projection is at capacity — registering
    // remotely without a local mirror would silently desync state and
    // hide the agent from list()/lookup() until eviction.
    if (projection.size >= maxEntries && !projection.has(entry.agentId)) {
      throw new Error(
        `Registry projection at capacity (${String(maxEntries)} entries); refuse to register ${entry.agentId} without a local mirror`,
      );
    }
    // Strip caller-supplied reserved keys before merging — register() must
    // enforce the same trust boundary as patch(). A caller-supplied
    // `koi:terminated`/`koi:status`/etc. would let user metadata flip
    // authoritative lifecycle state on first hydration.
    const sanitizedCallerMetadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.metadata)) {
      if (!RESERVED_METADATA_KEYS.has(k)) sanitizedCallerMetadata[k] = v;
    }
    const koiMetadata = encodeKoiStatus(entry.status);
    const merged: Record<string, unknown> = {
      ...sanitizedCallerMetadata,
      ...koiMetadata,
      // Explicitly clear koi:terminated when the status is not terminated;
      // encodeKoiStatus only sets it for terminated, so without this a
      // future caller-supplied value (already filtered above) or a stale
      // remote flag could bleed through on round-trip.
      ...(entry.status.phase !== "terminated" ? { "koi:terminated": false } : {}),
      agentType: entry.agentType,
      registeredAt: entry.registeredAt,
      priority: entry.priority,
      ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
      ...(entry.spawner !== undefined ? { spawner: entry.spawner } : {}),
      ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
    };

    const registerResult = await nexusRegisterAgent(transport, {
      agent_id: entry.agentId,
      name: entry.agentId,
      metadata: merged,
      ...(entry.zoneId !== undefined
        ? { zone_id: entry.zoneId }
        : config.zoneId !== undefined
          ? { zone_id: config.zoneId }
          : {}),
    });

    if (!registerResult.ok) {
      throw new Error(
        `Failed to register agent ${entry.agentId} in Nexus: ${registerResult.error.message}`,
        { cause: registerResult.error },
      );
    }

    async function rollbackOrphan(reason: string, cause: unknown): Promise<never> {
      // Best-effort cleanup of the partially-created Nexus record. Swallow
      // delete errors to avoid masking the original failure; surface them as
      // the cause chain instead.
      const deleteAttempt = await nexusDeleteAgent(transport, entry.agentId);
      const failure = !deleteAttempt.ok ? deleteAttempt.error : undefined;
      throw new Error(
        `Failed to register agent ${entry.agentId}: ${reason}${
          failure !== undefined ? ` (rollback also failed: ${failure.message})` : ""
        }`,
        { cause },
      );
    }

    // let: advances through setup transitions
    let currentNexusGen = registerResult.value.generation ?? 0;

    const targetNexusState = mapKoiToNexus(entry.status.phase);
    const connectedResult = await nexusTransition(
      transport,
      entry.agentId,
      "CONNECTED",
      currentNexusGen,
    );
    if (!connectedResult.ok) {
      await rollbackOrphan(
        `transition to CONNECTED failed: ${connectedResult.error.message}`,
        connectedResult.error,
      );
    }
    currentNexusGen = connectedResult.ok
      ? (connectedResult.value.generation ?? currentNexusGen + 1)
      : currentNexusGen;

    if (targetNexusState !== "CONNECTED") {
      const targetResult = await nexusTransition(
        transport,
        entry.agentId,
        targetNexusState,
        currentNexusGen,
      );
      if (!targetResult.ok) {
        await rollbackOrphan(
          `transition to ${targetNexusState} failed: ${targetResult.error.message}`,
          targetResult.error,
        );
      }
      currentNexusGen = targetResult.ok
        ? (targetResult.value.generation ?? currentNexusGen + 1)
        : currentNexusGen;
    }

    // Canonicalize the post-transition Koi phase. Nexus only carries
    // CONNECTED/IDLE/SUSPENDED, so caller-supplied phases like "created"
    // (→ CONNECTED → "running") and "idle" (→ IDLE → "waiting") are
    // collapsed by the round-trip mapping. Storing the original phase
    // would leave the local mirror disagreeing with Nexus indefinitely
    // (the poll generation short-circuit prevents repair). Force the
    // mirror to the canonical post-transition phase and rewrite the
    // koi:status metadata so subsequent reads see consistent state.
    const canonicalPhase = mapNexusToKoi(targetNexusState, merged);
    const canonicalStatus: AgentStatus = { ...entry.status, phase: canonicalPhase };
    const canonicalMerged: Record<string, unknown> = {
      ...merged,
      ...encodeKoiStatus(canonicalStatus),
    };

    if (canonicalPhase !== entry.status.phase) {
      // Rewrite the lifecycle metadata so Nexus reflects the canonical
      // phase too — otherwise the next poll/refetch would re-hydrate from
      // stale koi:status and the generation short-circuit would prevent
      // repair. Best-effort: if this rewrite fails, keep the canonical
      // local view (Nexus state is already the source of truth for phase).
      const rewriteResult = await nexusUpdateMetadata(transport, entry.agentId, canonicalMerged);
      if (rewriteResult.ok && rewriteResult.value.generation !== undefined) {
        currentNexusGen = rewriteResult.value.generation;
      }
    }

    // Store the merged metadata blob locally so subsequent
    // patch()/transition() round-trips don't drop identity fields
    // (agentType, registeredAt, parent/spawner/group) or lifecycle
    // markers (koi:status, koi:terminated) when rebuilding the outbound
    // metadata from `current.metadata`.
    // Persist the effective zoneId used in the Nexus write. Without this
    // a registration that picked up `config.zoneId` (because entry.zoneId
    // was undefined) would create a split-brain projection: Nexus has the
    // agent in a zone, local mirror reports zoneId=undefined, and
    // list({ zoneId }) / zone-scoped schedulers would miss it.
    const effectiveZoneId =
      entry.zoneId ?? (config.zoneId !== undefined ? zoneId(config.zoneId) : undefined);
    const stored: RegistryEntry = {
      ...entry,
      status: canonicalStatus,
      metadata: canonicalMerged,
      ...(effectiveZoneId !== undefined ? { zoneId: effectiveZoneId } : {}),
    };
    projection.set(entry.agentId, stored);
    nexusGens.set(entry.agentId, currentNexusGen);
    // Clear all per-ID failure state — re-registering a previously
    // tombstoned ID with a fresh agent must not stay invisible.
    stale.delete(entry.agentId);
    perAgentGetFailures.delete(entry.agentId);

    notify({ kind: "registered", entry: stored });
    return stored;
  }

  async function deregister(id: AgentId): Promise<boolean> {
    assertHealthy();
    const existed = projection.has(id);
    if (!existed) return false;

    const deleteResult = await nexusDeleteAgent(transport, id);
    if (!deleteResult.ok) {
      // Nexus is the source of truth — if delete failed there, do not
      // drop local state. Otherwise local would believe the agent is gone
      // while Nexus still has it (split-brain) until the next poll.
      throw new Error(`Failed to delete agent ${id} from Nexus: ${deleteResult.error.message}`, {
        cause: deleteResult.error,
      });
    }
    projection.delete(id);
    nexusGens.delete(id);
    stale.delete(id);
    perAgentGetFailures.delete(id);
    notify({ kind: "deregistered", agentId: id });
    return true;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    assertHealthy();
    if (stale.has(id)) return undefined;
    return projection.get(id);
  }

  function list(
    filter?: RegistryFilter,
    _visibility?: VisibilityContext,
  ): readonly RegistryEntry[] {
    assertHealthy();
    // VisibilityContext is intentionally not enforced here — that is the
    // job of createVisibilityFilter() (L2 engine-compose), which wraps an
    // inner registry and applies permission scoping before returning the
    // filtered set. Throwing here would break the AgentRegistry contract
    // and break every permission-scoped caller (MCP koi_list_agents,
    // createVisibilityFilter, discoverBySkill). The parameter is accepted
    // and ignored so the contract remains satisfied.
    const entries = [...projection.values()].filter((e) => !stale.has(e.agentId));
    if (filter === undefined) return entries;
    return entries.filter((e) => matchesFilter(e, filter));
  }

  async function transition(
    id: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ): Promise<Result<RegistryEntry, KoiError>> {
    assertHealthy();
    if (stale.has(id)) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Agent ${id} is in a tombstoned reconcile-pending state; refetch from Nexus must succeed before phase transitions can resume`,
          retryable: true,
        },
      };
    }
    const current = projection.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    if (current.status.generation !== expectedGeneration) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Stale generation: expected ${String(expectedGeneration)}, current ${String(current.status.generation)}`,
          retryable: true,
        },
      };
    }

    const allowed = VALID_TRANSITIONS[current.status.phase];
    if (!allowed.some((s) => s === targetPhase)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Invalid transition: ${current.status.phase} → ${targetPhase}. Allowed: [${allowed.join(", ")}]`,
          retryable: false,
        },
      };
    }

    const targetNexusState = mapKoiToNexus(targetPhase);
    const currentNexusGen = nexusGens.get(id) ?? 0;
    const nexusResult = await nexusTransition(transport, id, targetNexusState, currentNexusGen);

    if (!nexusResult.ok) {
      if (nexusResult.error.code === "CONFLICT") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Concurrent modification on agent ${id} in Nexus`,
            retryable: true,
          },
        };
      }
      return { ok: false, error: nexusResult.error };
    }

    nexusGens.set(id, nexusResult.value.generation ?? currentNexusGen + 1);

    const newStatus: AgentStatus = {
      phase: targetPhase,
      generation: current.status.generation + 1,
      conditions: [...current.status.conditions],
      reason,
      lastTransitionAt: Date.now(),
    };

    const updateResult = await nexusUpdateMetadata(
      transport,
      id,
      {
        ...current.metadata,
        ...encodeKoiStatus(newStatus),
      },
      // CAS: bind to the post-transition Nexus generation so a concurrent
      // writer cannot clobber this update by overwriting an older blob.
      nexusGens.get(id),
    );

    // Materialize the new lifecycle metadata so subsequent patch() calls
    // don't replay a stale koi:status blob (which would clobber the
    // terminated marker, etc.).
    const refreshedMetadata: Readonly<Record<string, unknown>> = {
      ...current.metadata,
      ...encodeKoiStatus(newStatus),
    };

    if (!updateResult.ok) {
      // agent_transition committed remotely, but the lifecycle metadata
      // write did not. Reconcile the local projection from the
      // authoritative Nexus record so we don't claim a phase that Nexus
      // cannot actually represent without the missing metadata flag
      // (notably: terminated requires `koi:terminated=true` to round-trip
      // through the lossy SUSPENDED state).
      // Bounded retry: dropping the entry on a single transient failure
      // would orphan the live Nexus agent when polling is disabled.
      const RECONCILE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
        }
        const refetch = await nexusGetAgent(transport, id);
        if (refetch.ok) {
          // Unknown-state errors during reconciliation should not crash
          // the caller; treat as a refetch failure for the next attempt.
          let reconciled: RegistryEntry;
          try {
            reconciled = mapNexusAgentToEntry(refetch.value);
          } catch {
            continue;
          }
          projection.set(id, reconciled);
          nexusGens.set(id, refetch.value.generation ?? currentNexusGen);
          stale.delete(id);
          if (reconciled.status.phase !== current.status.phase) {
            notify({
              kind: "transitioned",
              agentId: id,
              from: current.status.phase,
              to: reconciled.status.phase,
              generation: reconciled.status.generation,
              reason,
            });
          }
          return { ok: false, error: updateResult.error };
        }
      }
      // All retries exhausted. Tombstone the entry: keep it for
      // deregister/recovery, but block lookup/list/mutating reads so
      // callers don't act on the known-stale phase. A successful poll or
      // subsequent transition will clear the tombstone.
      stale.add(id);
      console.warn(
        `[registry-nexus] reconcile failed for ${id} after ${String(RECONCILE_ATTEMPTS)} attempts (last error: ${updateResult.error.message}); tombstoning local projection — reads return undefined until Nexus refetch succeeds`,
      );
      return { ok: false, error: updateResult.error };
    }

    if (updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    const updated: RegistryEntry = {
      ...current,
      status: newStatus,
      metadata: refreshedMetadata,
    };
    projection.set(id, updated);

    notify({
      kind: "transitioned",
      agentId: id,
      from: current.status.phase,
      to: targetPhase,
      generation: newStatus.generation,
      reason,
    });

    return { ok: true, value: updated };
  }

  async function patch(
    id: AgentId,
    fields: PatchableRegistryFields,
  ): Promise<Result<RegistryEntry, KoiError>> {
    assertHealthy();
    if (stale.has(id)) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Agent ${id} is in a tombstoned reconcile-pending state; refetch must succeed before patches can resume`,
          retryable: true,
        },
      };
    }
    const current = projection.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    if (fields.metadata !== undefined) {
      const reserved = Object.keys(fields.metadata).filter((k) => RESERVED_METADATA_KEYS.has(k));
      if (reserved.length > 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `patch({ metadata }) cannot overwrite registry-owned keys: ${reserved.join(", ")}`,
            retryable: false,
          },
        };
      }
    }

    if (fields.zoneId !== undefined) {
      // Nexus does not expose a zone-move RPC, and `update_agent_metadata`
      // does not touch the authoritative `agent.zone_id` field. Accepting
      // a zoneId patch would make the local projection diverge from Nexus
      // and silently revert on the next poll. Fail closed instead.
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "patch({ zoneId }) is not supported by registry-nexus — Nexus has no zone-move RPC",
          retryable: false,
        },
      };
    }

    const nexusMeta: Record<string, unknown> = { ...current.metadata };
    if (fields.priority !== undefined) nexusMeta.priority = fields.priority;
    if (fields.metadata !== undefined) Object.assign(nexusMeta, fields.metadata);

    // Local metadata mirror MUST match the outbound Nexus payload — the
    // adapter rebuilds outbound metadata from `current.metadata` on later
    // writes, so any divergence here will get re-sent and clobber Nexus.
    const updated: RegistryEntry = {
      ...current,
      ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
      metadata: nexusMeta,
    };

    // CAS: bind the patch to the last-known Nexus generation so concurrent
    // writers can't clobber newer state with this stale-built blob.
    const updateResult = await nexusUpdateMetadata(transport, id, nexusMeta, nexusGens.get(id));
    if (!updateResult.ok) {
      if (updateResult.error.code === "CONFLICT") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Concurrent modification on agent ${id} in Nexus`,
            retryable: true,
          },
        };
      }
      return { ok: false, error: updateResult.error };
    }

    if (updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    projection.set(id, updated);
    notify({ kind: "patched", agentId: id, fields, entry: updated });

    return { ok: true, value: updated };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    return listeners.subscribe(listener);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    projection.clear();
    nexusGens.clear();
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`createNexusRegistry warmup timed out after ${String(startupTimeoutMs)}ms`));
    }, startupTimeoutMs);
  });
  try {
    await Promise.race([loadProjection(), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  function schedulePoll(): void {
    if (disposed || broken !== undefined || pollIntervalMs <= 0) return;
    pollTimer = setTimeout(async () => {
      if (pollInFlight) {
        // Should not happen with self-scheduling, but guard against
        // re-entrant calls from manual triggers / tests.
        schedulePoll();
        return;
      }
      pollInFlight = true;
      try {
        await poll();
      } finally {
        pollInFlight = false;
        schedulePoll();
      }
    }, pollIntervalMs);
  }

  schedulePoll();

  return {
    register,
    deregister,
    lookup,
    list,
    transition,
    patch,
    watch,
    [Symbol.asyncDispose]: dispose,
  };
}
