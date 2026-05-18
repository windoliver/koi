import { describe, expect, test } from "bun:test";
import { zoneId } from "@koi/core";
import { createInMemoryRaftCluster } from "./raft-consensus.js";

describe("createInMemoryRaftCluster", () => {
  test("elects a leader from the healthy quorum", () => {
    const cluster = createInMemoryRaftCluster({
      nodes: [zoneId("zone-a"), zoneId("zone-b"), zoneId("zone-c")],
    });

    expect(cluster.getLeader()).toBe(zoneId("zone-a"));
    expect(cluster.getNode(zoneId("zone-a"))?.role).toBe("leader");
  });

  test("replicates committed log entries to followers", () => {
    const cluster = createInMemoryRaftCluster({
      nodes: [zoneId("zone-a"), zoneId("zone-b"), zoneId("zone-c")],
    });

    const result = cluster.append({ kind: "set", key: "policy", value: "locked" });

    expect(result.ok).toBe(true);
    expect(cluster.getLog(zoneId("zone-a"))).toEqual(cluster.getLog(zoneId("zone-b")));
    expect(cluster.getLog(zoneId("zone-b"))).toEqual(cluster.getLog(zoneId("zone-c")));
    expect(cluster.getCommittedState()).toEqual({ policy: "locked" });
  });

  test("leader failure triggers re-election and preserves committed log", () => {
    const cluster = createInMemoryRaftCluster({
      nodes: [zoneId("zone-a"), zoneId("zone-b"), zoneId("zone-c")],
    });

    expect(cluster.append({ kind: "set", key: "generation", value: 1 }).ok).toBe(true);

    cluster.markNodeUnhealthy(zoneId("zone-a"));

    expect(cluster.getLeader()).toBe(zoneId("zone-b"));
    expect(cluster.append({ kind: "set", key: "generation", value: 2 }).ok).toBe(true);
    expect(cluster.getCommittedState()).toEqual({ generation: 2 });
    expect(cluster.getLog(zoneId("zone-b"))).toEqual(cluster.getLog(zoneId("zone-c")));
  });

  test("detects split-brain when partitions elect different leaders", () => {
    const cluster = createInMemoryRaftCluster({
      nodes: [zoneId("zone-a"), zoneId("zone-b"), zoneId("zone-c"), zoneId("zone-d")],
    });

    cluster.partition([
      [zoneId("zone-a"), zoneId("zone-b")],
      [zoneId("zone-c"), zoneId("zone-d")],
    ]);
    cluster.forceElection(zoneId("zone-a"));
    cluster.forceElection(zoneId("zone-c"));

    expect(cluster.detectSplitBrain()).toEqual({
      term: 3,
      leaders: [zoneId("zone-a"), zoneId("zone-c")],
    });
  });

  test("recovery converges on the longest committed log after partition heals", () => {
    const cluster = createInMemoryRaftCluster({
      nodes: [zoneId("zone-a"), zoneId("zone-b"), zoneId("zone-c")],
    });

    expect(cluster.append({ kind: "set", key: "epoch", value: 1 }).ok).toBe(true);
    cluster.partition([[zoneId("zone-a")], [zoneId("zone-b"), zoneId("zone-c")]]);
    cluster.markNodeUnhealthy(zoneId("zone-a"));
    expect(cluster.append({ kind: "set", key: "epoch", value: 2 }).ok).toBe(true);

    cluster.healPartition();
    cluster.markNodeHealthy(zoneId("zone-a"));

    expect(cluster.detectSplitBrain()).toBeUndefined();
    expect(cluster.getCommittedState()).toEqual({ epoch: 2 });
    expect(cluster.getLog(zoneId("zone-a"))).toEqual(cluster.getLog(zoneId("zone-b")));
    expect(cluster.getLog(zoneId("zone-b"))).toEqual(cluster.getLog(zoneId("zone-c")));
  });
});
