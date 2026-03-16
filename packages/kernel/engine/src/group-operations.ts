/**
 * Process group utility functions — list members and fan-out signals
 * to all agents in a group.
 *
 * These are utility functions in L1, NOT methods on AgentRegistry.
 * Using Promise.allSettled() for concurrent signal dispatch so a single
 * slow/failing agent does not block others.
 */

import type {
  AgentGroupId,
  AgentId,
  AgentRegistry,
  AgentSignal,
  ChildHandle,
  RegistryEntry,
} from "@koi/core";
import { AGENT_SIGNALS } from "@koi/core";

/** Default deadline for signalGroup() before timeout error is raised. */
const DEFAULT_SIGNAL_GROUP_DEADLINE_MS = 5000;

// ---------------------------------------------------------------------------
// listByGroup
// ---------------------------------------------------------------------------

/**
 * List all registered agents in the given process group.
 * O(n) scan — consistent with all other filter operations.
 */
export function listByGroup(
  registry: AgentRegistry,
  groupId: AgentGroupId,
): readonly RegistryEntry[] | Promise<readonly RegistryEntry[]> {
  return registry.list({ groupId });
}

// ---------------------------------------------------------------------------
// signalGroup
// ---------------------------------------------------------------------------

/**
 * Fan-out a signal to all active members of a process group.
 *
 * - Uses `Promise.allSettled()` so individual failures don't block others.
 * - Throws if the configurable deadline is exceeded.
 * - Skips agents that are already terminated.
 * - When a `ChildHandle` map is provided, delegates to `handle.signal()`.
 *   Otherwise, applies the signal directly via registry transitions.
 */
export async function signalGroup(
  registry: AgentRegistry,
  groupId: AgentGroupId,
  signal: AgentSignal,
  options?: {
    /** Map of child handles keyed by AgentId — used for handle-aware signaling. */
    readonly handles?: ReadonlyMap<AgentId, ChildHandle>;
    /** Deadline in ms before signalGroup rejects with a timeout error. Default: 5000ms. */
    readonly deadlineMs?: number;
  },
): Promise<void> {
  const members = await listByGroup(registry, groupId);
  const activeMembers = members.filter((m) => m.status.phase !== "terminated");

  if (activeMembers.length === 0) return;

  const deadlineMs = options?.deadlineMs ?? DEFAULT_SIGNAL_GROUP_DEADLINE_MS;

  const ops = activeMembers.map(async (member) => {
    const handle = options?.handles?.get(member.agentId);

    if (handle !== undefined) {
      await handle.signal(signal);
      return;
    }

    // Direct registry transitions for state-changing signals (no handle needed)
    switch (signal) {
      case AGENT_SIGNALS.STOP:
        if (member.status.phase === "running" || member.status.phase === "waiting") {
          await registry.transition(member.agentId, "suspended", member.status.generation, {
            kind: "signal_stop",
          });
        }
        break;

      case AGENT_SIGNALS.CONT:
        if (member.status.phase === "suspended") {
          await registry.transition(member.agentId, "running", member.status.generation, {
            kind: "signal_cont",
          });
        }
        break;

      case AGENT_SIGNALS.TERM:
        if (member.status.phase !== "terminated") {
          await registry.transition(member.agentId, "terminated", member.status.generation, {
            kind: "evicted",
          });
        }
        break;

      case AGENT_SIGNALS.USR1:
      case AGENT_SIGNALS.USR2:
        // No-op without a handle — application-defined signals require handle access
        break;
    }
  });

  // Best-effort fan-out: allSettled results are intentionally discarded.
  // Individual operation failures are not propagated — group signaling is
  // a "signal and forget" operation where partial delivery is acceptable.
  // let justified: timer ID must be captured inside the Promise constructor and cleared externally
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`signalGroup timeout after ${deadlineMs}ms`)),
      deadlineMs,
    );
  });

  await Promise.race([Promise.allSettled(ops), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
