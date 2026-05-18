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
  return new InMemoryRaftClusterState(config.nodes);
}

type MutableRaftNodeState = { role: RaftNodeRole; term: number; healthy: boolean };

class InMemoryRaftClusterState implements InMemoryRaftCluster {
  private readonly nodeIds: readonly ZoneId[];
  private readonly nodeState: Map<ZoneId, MutableRaftNodeState>;
  private readonly logs: Map<ZoneId, readonly RaftLogEntry[]>;
  private readonly partitions: Map<ZoneId, number>;

  constructor(nodes: readonly ZoneId[]) {
    this.nodeIds = uniqueSorted(nodes);
    this.nodeState = new Map(
      this.nodeIds.map((id) => [id, { role: "follower", term: 0, healthy: true }]),
    );
    this.logs = new Map(this.nodeIds.map((id) => [id, []]));
    this.partitions = new Map(this.nodeIds.map((id) => [id, 0]));

    this.electLeader();
  }

  getLeader(): ZoneId | undefined {
    return [...this.nodeState.entries()].find(
      ([, node]) => node.role === "leader" && node.healthy,
    )?.[0];
  }

  private electLeader(): void {
    this.clearLeaders();
    const eligible = this.healthyNodesInLargestPartition();
    if (eligible.length < this.quorumSize()) return;

    const leaderId = eligible[0];
    if (leaderId === undefined) return;

    const nextTerm = this.currentTerm() + 1;
    for (const id of this.nodeIds) {
      const current = this.nodeState.get(id);
      if (current === undefined) continue;
      this.nodeState.set(id, {
        ...current,
        role: id === leaderId ? "leader" : "follower",
        term: nextTerm,
      });
    }
  }

  append(command: RaftCommand): Result<RaftLogEntry, KoiError> {
    if (this.detectSplitBrain() !== undefined) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Raft append failed: split-brain detected",
          retryable: true,
        },
      };
    }

    const leader = this.getLeader();
    if (leader === undefined) {
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "Raft append failed: no leader", retryable: true },
      };
    }

    const replicaIds = this.reachableHealthyNodes(leader);
    if (replicaIds.length < this.quorumSize()) {
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
      term: this.nodeState.get(leader)?.term ?? this.currentTerm(),
      index: this.longestLog().length + 1,
      command,
      committed: true,
    };

    for (const id of replicaIds) {
      this.logs.set(id, [...(this.logs.get(id) ?? []), entry]);
    }
    this.convergePartitionFor(leader);

    return { ok: true, value: entry };
  }

  markNodeUnhealthy(id: ZoneId): void {
    const current = this.nodeState.get(id);
    if (current === undefined) return;
    this.nodeState.set(id, { ...current, healthy: false, role: "follower" });
    if (this.getLeader() === undefined) this.electLeader();
  }

  markNodeHealthy(id: ZoneId): void {
    const current = this.nodeState.get(id);
    if (current === undefined) return;
    this.nodeState.set(id, {
      ...current,
      healthy: true,
      role: "follower",
      term: this.currentTerm(),
    });
    this.convergeAll();
    if (this.getLeader() === undefined) this.electLeader();
  }

  partition(groups: readonly (readonly ZoneId[])[]): void {
    const next = new Map<ZoneId, number>();
    groups.forEach((group, groupIndex) => {
      for (const id of group) {
        next.set(id, groupIndex);
      }
    });
    for (const id of this.nodeIds) {
      this.partitions.set(id, next.get(id) ?? groups.length);
    }
    this.clearLeaders();
  }

  healPartition(): void {
    for (const id of this.nodeIds) {
      this.partitions.set(id, 0);
    }
    this.convergeAll();
    this.electLeader();
  }

  forceElection(id: ZoneId): void {
    const current = this.nodeState.get(id);
    if (current === undefined || !current.healthy) return;
    const group = this.partitions.get(id) ?? 0;
    const nextTerm = this.currentTerm() + 1;
    for (const nodeId of this.nodeIds) {
      const node = this.nodeState.get(nodeId);
      if (node === undefined) continue;
      const sameGroup = (this.partitions.get(nodeId) ?? 0) === group;
      this.nodeState.set(nodeId, {
        ...node,
        role: nodeId === id ? "leader" : sameGroup ? "follower" : node.role,
        term: sameGroup ? nextTerm : node.term,
      });
    }
  }

  detectSplitBrain(): SplitBrainSnapshot | undefined {
    const leaders = [...this.nodeState.entries()]
      .filter(([, node]) => node.role === "leader" && node.healthy)
      .map(([id]) => id)
      .toSorted();

    if (leaders.length < 2) return undefined;
    return { term: this.currentTerm(), leaders };
  }

  getNode(id: ZoneId): RaftNodeSnapshot | undefined {
    const node = this.nodeState.get(id);
    if (node === undefined) return undefined;
    return { zoneId: id, ...node };
  }

  getLog(id: ZoneId): readonly RaftLogEntry[] {
    return this.logs.get(id) ?? [];
  }

  getCommittedState(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
      this.longestLog()
        .filter((entry) => entry.committed)
        .map((entry) => [entry.command.key, entry.command.value]),
    );
  }

  private convergeAll(): void {
    const committed = this.longestLog();
    for (const id of this.nodeIds) {
      if (this.nodeState.get(id)?.healthy === true) {
        this.logs.set(id, committed);
      }
    }
  }

  private convergePartitionFor(id: ZoneId): void {
    const group = this.partitions.get(id) ?? 0;
    const committed = this.longestLogInGroup(group);
    for (const nodeId of this.nodeIds) {
      if (
        (this.partitions.get(nodeId) ?? 0) === group &&
        this.nodeState.get(nodeId)?.healthy === true
      ) {
        this.logs.set(nodeId, committed);
      }
    }
  }

  private clearLeaders(): void {
    for (const [id, node] of this.nodeState.entries()) {
      this.nodeState.set(id, { ...node, role: "follower" });
    }
  }

  private healthyNodesInLargestPartition(): readonly ZoneId[] {
    const groups = new Map<number, readonly ZoneId[]>();
    for (const id of this.nodeIds) {
      if (this.nodeState.get(id)?.healthy !== true) continue;
      const group = this.partitions.get(id) ?? 0;
      groups.set(group, [...(groups.get(group) ?? []), id]);
    }
    return (
      [...groups.values()].toSorted(
        (a, b) => b.length - a.length || a[0]?.localeCompare(b[0] ?? "") || 0,
      )[0] ?? []
    );
  }

  private reachableHealthyNodes(from: ZoneId): readonly ZoneId[] {
    const group = this.partitions.get(from) ?? 0;
    return this.nodeIds.filter(
      (id) => this.nodeState.get(id)?.healthy === true && (this.partitions.get(id) ?? 0) === group,
    );
  }

  private longestLog(): readonly RaftLogEntry[] {
    return [...this.logs.values()].toSorted(compareLogs)[0] ?? [];
  }

  private longestLogInGroup(group: number): readonly RaftLogEntry[] {
    const groupLogs = this.nodeIds
      .filter(
        (id) =>
          (this.partitions.get(id) ?? 0) === group && this.nodeState.get(id)?.healthy === true,
      )
      .map((id) => this.logs.get(id) ?? []);
    return groupLogs.toSorted(compareLogs)[0] ?? [];
  }

  private currentTerm(): number {
    return Math.max(0, ...[...this.nodeState.values()].map((node) => node.term));
  }

  private quorumSize(): number {
    return Math.floor(this.nodeIds.length / 2) + 1;
  }
}

function uniqueSorted(ids: readonly ZoneId[]): readonly ZoneId[] {
  return [...new Set(ids)].toSorted();
}

function compareLogs(a: readonly RaftLogEntry[], b: readonly RaftLogEntry[]): number {
  const lengthDelta = b.length - a.length;
  if (lengthDelta !== 0) return lengthDelta;
  return (b.at(-1)?.term ?? 0) - (a.at(-1)?.term ?? 0);
}
