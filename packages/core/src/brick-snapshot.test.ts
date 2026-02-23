import { describe, expect, test } from "bun:test";
import type {
  BrickId,
  BrickRef,
  BrickSnapshot,
  BrickSource,
  SnapshotEvent,
  SnapshotId,
} from "./brick-snapshot.js";
import { brickId, snapshotId } from "./brick-snapshot.js";

describe("brick-snapshot branded types", () => {
  test("brickId() creates a branded BrickId", () => {
    const id: BrickId = brickId("brick_abc123");
    expect(id).toBe(brickId("brick_abc123"));
    // Branded type is structurally a string
    expect(typeof id).toBe("string");
  });

  test("snapshotId() creates a branded SnapshotId", () => {
    const id: SnapshotId = snapshotId("snap_xyz789");
    expect(id).toBe(snapshotId("snap_xyz789"));
    expect(typeof id).toBe("string");
  });

  test("BrickRef interface compiles with correct shape", () => {
    const ref: BrickRef = {
      id: brickId("brick_1"),
      version: "1.0.0",
      kind: "tool",
      contentHash: "abc123",
    };
    expect(ref.id).toBe(brickId("brick_1"));
    expect(ref.version).toBe("1.0.0");
  });

  test("BrickSource discriminated union covers all origins", () => {
    const forged: BrickSource = { origin: "forged", forgedBy: "agent-1", sessionId: "s1" };
    const bundled: BrickSource = { origin: "bundled", bundleName: "starter", bundleVersion: "1.0" };
    const external: BrickSource = { origin: "external", registry: "npm", packageRef: "@koi/tools" };

    expect(forged.origin).toBe("forged");
    expect(bundled.origin).toBe("bundled");
    expect(external.origin).toBe("external");
  });

  test("SnapshotEvent discriminated union covers all types", () => {
    const created: SnapshotEvent = { kind: "created", actor: "agent-1", timestamp: 1000 };
    const updated: SnapshotEvent = {
      kind: "updated",
      actor: "agent-1",
      timestamp: 2000,
      fieldsChanged: ["name"],
    };
    const promoted: SnapshotEvent = {
      kind: "promoted",
      actor: "admin",
      timestamp: 3000,
      fromTier: "shared",
      toTier: "agent",
    };
    const deprecated: SnapshotEvent = {
      kind: "deprecated",
      actor: "admin",
      timestamp: 4000,
      reason: "replaced",
    };

    expect(created.kind).toBe("created");
    expect(updated.kind).toBe("updated");
    expect(promoted.kind).toBe("promoted");
    expect(deprecated.kind).toBe("deprecated");
  });

  test("BrickSnapshot interface compiles with all fields", () => {
    const snapshot: BrickSnapshot = {
      snapshotId: snapshotId("snap_1"),
      brickId: brickId("brick_1"),
      version: "1.0.0",
      parentSnapshotId: snapshotId("snap_0"),
      source: { origin: "forged", forgedBy: "agent-1" },
      event: { kind: "created", actor: "agent-1", timestamp: Date.now() },
      artifact: { implementation: "return 1;" },
      contentHash: "sha256-abc",
      createdAt: Date.now(),
    };
    expect(snapshot.snapshotId).toBe(snapshotId("snap_1"));
    expect(snapshot.brickId).toBe(brickId("brick_1"));
    expect(snapshot.parentSnapshotId).toBe(snapshotId("snap_0"));
  });

  test("BrickSnapshot without optional parentSnapshotId", () => {
    const snapshot: BrickSnapshot = {
      snapshotId: snapshotId("snap_1"),
      brickId: brickId("brick_1"),
      version: "1.0.0",
      source: { origin: "bundled", bundleName: "core", bundleVersion: "0.1.0" },
      event: { kind: "created", actor: "system", timestamp: Date.now() },
      artifact: {},
      contentHash: "sha256-def",
      createdAt: Date.now(),
    };
    expect(snapshot.parentSnapshotId).toBeUndefined();
  });
});
