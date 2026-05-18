/**
 * Deterministic in-memory Raft-style consensus for critical federation state.
 *
 * This is intentionally small and adapter-shaped: production deployments can
 * replace it with an etcd/Coaty-backed implementation while tests and local
 * runtimes get leader election, quorum replication, split-brain detection, and
 * convergence semantics without a native storage dependency.
 */

import type { KoiError, Result, ZoneId } from "@koi/core";

export type RaftNodeRole = "leader" | "follower" | "candidate";
export type RaftCommand = { readonly kind: "set"; readonly key: string; readonly value: unknown };

export interface RaftLogEntry {
  readonly term: number;
  readonly index: number;
  readonly command: RaftCommand;
  readonly committed: boolean;
}

export interface RaftNodeSnapshot {
  readonly zoneId: ZoneId;
  readonly role: RaftNodeRole;
  readonly term: number;
  readonly healthy: boolean;
}

export interface SplitBrainSnapshot {
  readonly term: number;
  readonly leaders: readonly ZoneId[];
}

export interface InMemoryRaftCluster {
  readonly getLeader: () => ZoneId | undefined;
  readonly getNode: (zoneId: ZoneId) => RaftNodeSnapshot | undefined;
  readonly getLog: (zoneId: ZoneId) => readonly RaftLogEntry[];
  readonly getCommittedState: () => Readonly<Record<string, unknown>>;
  readonly append: (command: RaftCommand) => Result<RaftLogEntry, KoiError>;
  readonly markNodeUnhealthy: (zoneId: ZoneId) => void;
  readonly markNodeHealthy: (zoneId: ZoneId) => void;
  readonly partition: (groups: readonly (readonly ZoneId[])[]) => void;
  readonly healPartition: () => void;
  readonly forceElection: (zoneId: ZoneId) => void;
  readonly detectSplitBrain: () => SplitBrainSnapshot | undefined;
}

export function createInMemoryRaftCluster(config: {
  readonly nodes: readonly ZoneId[];
}): InMemoryRaftCluster {
  const nodeIds = uniqueSorted(config.nodes);
  const nodeState = new Map<ZoneId, { role: RaftNodeRole; term: number; healthy: boolean }>(
    nodeIds.map((id) => [id, { role: "follower", term: 0, healthy: true }]),
  );
  const logs = new Map<ZoneId, readonly RaftLogEntry[]>(nodeIds.map((id) => [id, []]));
  const partitions = new Map<ZoneId, number>(nodeIds.map((id) => [id, 0]));

  electLeader();

  function getLeader(): ZoneId | undefined {
    return [...nodeState.entries()].find(([, node]) => node.role === "leader" && node.healthy)?.[0];
  }

  function electLeader(): void {
    clearLeaders();
    const eligible = healthyNodesInLargestPartition();
    if (eligible.length < quorumSize()) return;

    const leaderId = eligible[0];
    if (leaderId === undefined) return;

    const nextTerm = currentTerm() + 1;
    for (const id of nodeIds) {
      const current = nodeState.get(id);
      if (current === undefined) continue;
      nodeState.set(id, {
        ...current,
        role: id === leaderId ? "leader" : "follower",
        term: nextTerm,
      });
    }
  }

  function append(command: RaftCommand): Result<RaftLogEntry, KoiError> {
    if (detectSplitBrain() !== undefined) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Raft append failed: split-brain detected",
          retryable: true,
        },
      };
    }

    const leader = getLeader();
    if (leader === undefined) {
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "Raft append failed: no leader", retryable: true },
      };
    }

    const replicaIds = reachableHealthyNodes(leader);
    if (replicaIds.length < quorumSize()) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Raft append failed: leader cannot reach quorum",
          retryable: true,
        },
      };
    }

    const entry: RaftLogEntry = {
      term: nodeState.get(leader)?.term ?? currentTerm(),
      index: longestLog().length + 1,
      command,
      committed: true,
    };

    for (const id of replicaIds) {
      logs.set(id, [...(logs.get(id) ?? []), entry]);
    }
    convergePartitionFor(leader);

    return { ok: true, value: entry };
  }

  function markNodeUnhealthy(id: ZoneId): void {
    const current = nodeState.get(id);
    if (current === undefined) return;
    nodeState.set(id, { ...current, healthy: false, role: "follower" });
    if (getLeader() === undefined) electLeader();
  }

  function markNodeHealthy(id: ZoneId): void {
    const current = nodeState.get(id);
    if (current === undefined) return;
    nodeState.set(id, { ...current, healthy: true, role: "follower", term: currentTerm() });
    convergeAll();
    if (getLeader() === undefined) electLeader();
  }

  function partition(groups: readonly (readonly ZoneId[])[]): void {
    const next = new Map<ZoneId, number>();
    groups.forEach((group, groupIndex) => {
      for (const id of group) {
        next.set(id, groupIndex);
      }
    });
    for (const id of nodeIds) {
      partitions.set(id, next.get(id) ?? groups.length);
    }
    clearLeaders();
  }

  function healPartition(): void {
    for (const id of nodeIds) {
      partitions.set(id, 0);
    }
    convergeAll();
    electLeader();
  }

  function forceElection(id: ZoneId): void {
    const current = nodeState.get(id);
    if (current === undefined || !current.healthy) return;
    const group = partitions.get(id) ?? 0;
    const nextTerm = currentTerm() + 1;
    for (const nodeId of nodeIds) {
      const node = nodeState.get(nodeId);
      if (node === undefined) continue;
      const sameGroup = (partitions.get(nodeId) ?? 0) === group;
      nodeState.set(nodeId, {
        ...node,
        role: nodeId === id ? "leader" : sameGroup ? "follower" : node.role,
        term: sameGroup ? nextTerm : node.term,
      });
    }
  }

  function detectSplitBrain(): SplitBrainSnapshot | undefined {
    const leaders = [...nodeState.entries()]
      .filter(([, node]) => node.role === "leader" && node.healthy)
      .map(([id]) => id)
      .toSorted();

    if (leaders.length < 2) return undefined;
    return { term: currentTerm(), leaders };
  }

  function getNode(id: ZoneId): RaftNodeSnapshot | undefined {
    const node = nodeState.get(id);
    if (node === undefined) return undefined;
    return { zoneId: id, ...node };
  }

  function getCommittedState(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
      longestLog()
        .filter((entry) => entry.committed)
        .map((entry) => [entry.command.key, entry.command.value]),
    );
  }

  function convergeAll(): void {
    const committed = longestLog();
    for (const id of nodeIds) {
      if (nodeState.get(id)?.healthy === true) {
        logs.set(id, committed);
      }
    }
  }

  function convergePartitionFor(id: ZoneId): void {
    const group = partitions.get(id) ?? 0;
    const committed = longestLogInGroup(group);
    for (const nodeId of nodeIds) {
      if ((partitions.get(nodeId) ?? 0) === group && nodeState.get(nodeId)?.healthy === true) {
        logs.set(nodeId, committed);
      }
    }
  }

  function clearLeaders(): void {
    for (const [id, node] of nodeState.entries()) {
      nodeState.set(id, { ...node, role: "follower" });
    }
  }

  function healthyNodesInLargestPartition(): readonly ZoneId[] {
    const groups = new Map<number, readonly ZoneId[]>();
    for (const id of nodeIds) {
      if (nodeState.get(id)?.healthy !== true) continue;
      const group = partitions.get(id) ?? 0;
      groups.set(group, [...(groups.get(group) ?? []), id]);
    }
    return (
      [...groups.values()].toSorted(
        (a, b) => b.length - a.length || a[0]?.localeCompare(b[0] ?? "") || 0,
      )[0] ?? []
    );
  }

  function reachableHealthyNodes(from: ZoneId): readonly ZoneId[] {
    const group = partitions.get(from) ?? 0;
    return nodeIds.filter(
      (id) => nodeState.get(id)?.healthy === true && (partitions.get(id) ?? 0) === group,
    );
  }

  function longestLog(): readonly RaftLogEntry[] {
    return [...logs.values()].toSorted(compareLogs)[0] ?? [];
  }

  function longestLogInGroup(group: number): readonly RaftLogEntry[] {
    const groupLogs = nodeIds
      .filter((id) => (partitions.get(id) ?? 0) === group && nodeState.get(id)?.healthy === true)
      .map((id) => logs.get(id) ?? []);
    return groupLogs.toSorted(compareLogs)[0] ?? [];
  }

  function currentTerm(): number {
    return Math.max(0, ...[...nodeState.values()].map((node) => node.term));
  }

  function quorumSize(): number {
    return Math.floor(nodeIds.length / 2) + 1;
  }

  return {
    getLeader,
    getNode,
    getLog: (id) => logs.get(id) ?? [],
    getCommittedState,
    append,
    markNodeUnhealthy,
    markNodeHealthy,
    partition,
    healPartition,
    forceElection,
    detectSplitBrain,
  };
}

function uniqueSorted(ids: readonly ZoneId[]): readonly ZoneId[] {
  return [...new Set(ids)].toSorted();
}

function compareLogs(a: readonly RaftLogEntry[], b: readonly RaftLogEntry[]): number {
  const lengthDelta = b.length - a.length;
  if (lengthDelta !== 0) return lengthDelta;
  return (b.at(-1)?.term ?? 0) - (a.at(-1)?.term ?? 0);
}
