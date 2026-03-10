/**
 * Tests for viewer routing logic — exercises the actual resolveViewerName
 * and resolveDirectoryViewerName from viewer-router.tsx (not a reimplementation).
 */

import { describe, expect, test } from "bun:test";
import { resolveDirectoryViewerName, resolveViewerName } from "./viewer-router.js";

// ---------------------------------------------------------------------------
// File viewer routing
// ---------------------------------------------------------------------------

describe("file viewer routing (resolveViewerName)", () => {
  test("manifest files route to manifest viewer", () => {
    expect(resolveViewerName("/agents/a1/manifest.json")).toBe("manifest");
    expect(resolveViewerName("/agents/a1/manifest.yaml")).toBe("manifest");
  });

  test("agent overview/index files route to agent-overview viewer", () => {
    expect(resolveViewerName("/agents/a1/overview.json")).toBe("agent-overview");
    expect(resolveViewerName("/agents/a1/index.json")).toBe("agent-overview");
    expect(resolveViewerName("/agents/my-agent/overview.json")).toBe("agent-overview");
  });

  test("brick files route to brick viewer", () => {
    expect(resolveViewerName("/agents/a1/bricks/my-brick.json")).toBe("brick");
    expect(resolveViewerName("/global/bricks/custom.json")).toBe("brick");
  });

  test("event stream metadata routes to event-stream viewer", () => {
    expect(resolveViewerName("/agents/a1/events/streams/stream-001/meta.json")).toBe(
      "event-stream",
    );
  });

  test("event detail (numeric) routes to event-detail viewer", () => {
    expect(resolveViewerName("/agents/a1/events/streams/s1/events/42.json")).toBe("event-detail");
    expect(resolveViewerName("/agents/a1/events/streams/s1/events/0000000247.json")).toBe(
      "event-detail",
    );
  });

  test("dead letter entries route to dead-letter viewer", () => {
    expect(resolveViewerName("/agents/a1/events/dead-letters/dl_abc123.json")).toBe("dead-letter");
  });

  test("subscription files route to subscription viewer", () => {
    expect(resolveViewerName("/agents/a1/events/subscriptions/sub-001.json")).toBe("subscription");
  });

  test("session records route to session-record viewer", () => {
    expect(resolveViewerName("/agents/a1/session/records/sess-abc.json")).toBe("session-record");
  });

  test("pending frames route to pending-frames viewer", () => {
    expect(resolveViewerName("/agents/a1/session/pending/frame-001.json")).toBe("pending-frames");
  });

  test("session files (catch-all) route to session viewer", () => {
    expect(resolveViewerName("/agents/a1/session/snapshot.json")).toBe("session");
  });

  test("memory overview files route to memory-overview viewer", () => {
    expect(resolveViewerName("/agents/a1/memory/index.json")).toBe("memory-overview");
    expect(resolveViewerName("/agents/a1/memory/overview.json")).toBe("memory-overview");
  });

  test("memory entity files route to memory-entity viewer", () => {
    expect(resolveViewerName("/agents/a1/memory/entities/user-prefs.json")).toBe("memory-entity");
  });

  test("memory non-JSON files route to memory viewer", () => {
    expect(resolveViewerName("/agents/a1/memory/notes.md")).toBe("memory");
  });

  test("snapshot chain metadata routes to snapshot-chain viewer", () => {
    expect(resolveViewerName("/agents/a1/snapshots/chain-001/meta.json")).toBe("snapshot-chain");
  });

  test("snapshot overview files route to snapshot-overview viewer", () => {
    expect(resolveViewerName("/agents/a1/snapshots/index.json")).toBe("snapshot-overview");
    expect(resolveViewerName("/agents/a1/snapshots/overview.json")).toBe("snapshot-overview");
  });

  test("snapshot node files route to snapshot-node viewer", () => {
    expect(resolveViewerName("/agents/a1/snapshots/chain-001/abcdef01.json")).toBe("snapshot-node");
  });

  test("mailbox files route to mailbox viewer", () => {
    expect(resolveViewerName("/agents/a1/mailbox/msg-001.json")).toBe("mailbox");
  });

  test("gateway session files route to gateway-session viewer", () => {
    expect(resolveViewerName("/global/gateway/sessions/sess-001.json")).toBe("gateway-session");
  });

  test("gateway node files route to gateway-node viewer", () => {
    expect(resolveViewerName("/global/gateway/nodes/node-001.json")).toBe("gateway-node");
  });

  test("gateway files (catch-all) route to gateway viewer", () => {
    expect(resolveViewerName("/global/gateway/topology.json")).toBe("gateway");
  });

  test("workspace files route to workspace viewer", () => {
    expect(resolveViewerName("/agents/a1/workspace/draft.txt")).toBe("workspace");
  });

  test("group scratchpad files route to scratchpad viewer", () => {
    expect(resolveViewerName("/groups/g1/scratch/notes.json")).toBe("scratchpad");
  });

  test("event log files route to event-log viewer", () => {
    expect(resolveViewerName("/agents/a1/events/2024-01-01.jsonl")).toBe("event-log");
  });

  test("generic JSON files route to json viewer", () => {
    expect(resolveViewerName("/some/config.json")).toBe("json");
    expect(resolveViewerName("/data/log.jsonl")).toBe("json");
  });

  test("text files route to text viewer", () => {
    expect(resolveViewerName("/readme.md")).toBe("text");
    expect(resolveViewerName("/config.yaml")).toBe("text");
    expect(resolveViewerName("/script.ts")).toBe("text");
  });

  test("unknown extensions fall through to text", () => {
    // text is the final fallback (no explicit match found)
    expect(resolveViewerName("/some/file.bin")).toBe("text");
  });

  // --- Specificity / ordering tests ---

  test("specificity: manifest.json in bricks dir routes to manifest (not brick)", () => {
    expect(resolveViewerName("/agents/a1/bricks/manifest.json")).toBe("manifest");
  });

  test("specificity: snapshot index routes to snapshot-overview (not snapshot-node)", () => {
    expect(resolveViewerName("/agents/a1/snapshots/index.json")).toBe("snapshot-overview");
  });

  test("specificity: gateway sessions routes to gateway-session (not gateway)", () => {
    expect(resolveViewerName("/global/gateway/sessions/s1.json")).toBe("gateway-session");
  });

  test("specificity: gateway nodes routes to gateway-node (not gateway)", () => {
    expect(resolveViewerName("/global/gateway/nodes/n1.json")).toBe("gateway-node");
  });

  test("specificity: memory index routes to memory-overview (not memory-entity)", () => {
    expect(resolveViewerName("/agents/a1/memory/index.json")).toBe("memory-overview");
  });
});

// ---------------------------------------------------------------------------
// Directory viewer routing
// ---------------------------------------------------------------------------

describe("directory viewer routing (resolveDirectoryViewerName)", () => {
  test("agent root routes to agent-overview", () => {
    expect(resolveDirectoryViewerName("/agents/a1/")).toBe("agent-overview");
    expect(resolveDirectoryViewerName("/agents/a1")).toBe("agent-overview");
    expect(resolveDirectoryViewerName("/agents/my-agent/")).toBe("agent-overview");
  });

  test("mailbox directory routes to mailbox", () => {
    expect(resolveDirectoryViewerName("/agents/a1/mailbox/")).toBe("mailbox");
    expect(resolveDirectoryViewerName("/agents/a1/mailbox")).toBe("mailbox");
  });

  test("bricks directory routes to bricks", () => {
    expect(resolveDirectoryViewerName("/agents/a1/bricks/")).toBe("bricks");
    expect(resolveDirectoryViewerName("/agents/a1/bricks")).toBe("bricks");
    expect(resolveDirectoryViewerName("/global/bricks/")).toBe("bricks");
  });

  test("events root routes to events", () => {
    expect(resolveDirectoryViewerName("/agents/a1/events/")).toBe("events");
    expect(resolveDirectoryViewerName("/agents/a1/events")).toBe("events");
  });

  test("event streams directory routes to event-streams", () => {
    expect(resolveDirectoryViewerName("/agents/a1/events/streams/")).toBe("event-streams");
    expect(resolveDirectoryViewerName("/agents/a1/events/streams")).toBe("event-streams");
  });

  test("dead-letters directory routes to dead-letters", () => {
    expect(resolveDirectoryViewerName("/agents/a1/events/dead-letters/")).toBe("dead-letters");
  });

  test("subscriptions directory routes to subscriptions", () => {
    expect(resolveDirectoryViewerName("/agents/a1/events/subscriptions/")).toBe("subscriptions");
  });

  test("session root routes to session", () => {
    expect(resolveDirectoryViewerName("/agents/a1/session/")).toBe("session");
    expect(resolveDirectoryViewerName("/agents/a1/session")).toBe("session");
  });

  test("session records directory routes to session-records", () => {
    expect(resolveDirectoryViewerName("/agents/a1/session/records/")).toBe("session-records");
  });

  test("pending frames directory routes to pending-frames", () => {
    expect(resolveDirectoryViewerName("/agents/a1/session/pending/sess-001/")).toBe(
      "pending-frames",
    );
  });

  test("memory directory routes to memory", () => {
    expect(resolveDirectoryViewerName("/agents/a1/memory/")).toBe("memory");
    expect(resolveDirectoryViewerName("/agents/a1/memory")).toBe("memory");
  });

  test("snapshots directory routes to snapshots", () => {
    expect(resolveDirectoryViewerName("/agents/a1/snapshots/")).toBe("snapshots");
  });

  test("gateway directory routes to gateway", () => {
    expect(resolveDirectoryViewerName("/global/gateway/")).toBe("gateway");
    expect(resolveDirectoryViewerName("/global/gateway")).toBe("gateway");
  });

  test("unrecognized directories return undefined (fallback to generic)", () => {
    expect(resolveDirectoryViewerName("/agents/a1/workspace/")).toBeUndefined();
    expect(resolveDirectoryViewerName("/global/config/")).toBeUndefined();
    expect(resolveDirectoryViewerName("/some/random/")).toBeUndefined();
  });
});
