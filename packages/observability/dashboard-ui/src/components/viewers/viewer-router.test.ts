/**
 * Tests for viewer routing logic — verifies path → viewer mapping.
 */

import { describe, expect, test } from "bun:test";

// Extract the match logic as a pure function for testing
// (mirrors VIEWER_RULES from viewer-router.tsx)
type ViewerType =
  | "manifest"
  | "agent-overview"
  | "dead-letter"
  | "event-stream"
  | "event-detail"
  | "brick-list"
  | "brick"
  | "event-log"
  | "subscription"
  | "pending-frames"
  | "session-list"
  | "session-record"
  | "session"
  | "memory-overview"
  | "memory-entity"
  | "memory"
  | "snapshot-overview"
  | "snapshot-chain"
  | "snapshot-node"
  | "mailbox"
  | "gateway-session"
  | "gateway-node"
  | "gateway"
  | "scratchpad"
  | "workspace"
  | "json"
  | "text"
  | "default";

function resolveViewerType(path: string): ViewerType {
  // Manifest files
  if (path.endsWith("/manifest.json") || path.endsWith("/manifest.yaml")) return "manifest";

  // Agent overview
  if (/\/agents\/[^/]+\/overview\.json$/.test(path) || /\/agents\/[^/]+\/index\.json$/.test(path))
    return "agent-overview";

  // Dead letter queue entries
  if ((path.includes("/events/dlq/") || path.includes("/dead-letter/")) && path.endsWith(".json"))
    return "dead-letter";

  // Event stream metadata
  if (path.includes("/events/") && (path.endsWith("/stream.json") || path.endsWith("/meta.json")))
    return "event-stream";

  // Event detail
  if (path.includes("/events/") && /\/evt[_-]/.test(path) && path.endsWith(".json"))
    return "event-detail";

  // Brick list
  if (path.includes("/bricks/") && (path.endsWith("/index.json") || path.endsWith("/list.json")))
    return "brick-list";

  // Brick definitions
  if (path.includes("/bricks/") && path.endsWith(".json")) return "brick";

  // Event logs
  if (path.includes("/events/") && (path.endsWith(".jsonl") || path.endsWith(".json")))
    return "event-log";

  // Subscription position files
  if (
    (path.includes("/subscriptions/") && path.endsWith(".json")) ||
    /\/subscription[_-]?[^/]*\.json$/.test(path)
  )
    return "subscription";

  // Gateway session files (before general session — /gateway/session/ contains /session/)
  if (
    (path.includes("/gateway/sessions/") || path.includes("/gateway/session/")) &&
    path.endsWith(".json")
  )
    return "gateway-session";

  // Gateway node files (before general gateway)
  if (
    (path.includes("/gateway/nodes/") || path.includes("/gateway/node/")) &&
    path.endsWith(".json")
  )
    return "gateway-node";

  // Pending frames
  if (
    (path.includes("/session/pending/") || path.includes("/pending-frames")) &&
    path.endsWith(".json")
  )
    return "pending-frames";

  // Session list
  if (
    path.includes("/session/") &&
    (path.endsWith("/index.json") || path.endsWith("/list.json") || path.endsWith("/sessions.json"))
  )
    return "session-list";

  // Session record
  if (
    path.includes("/session/") &&
    (path.includes("/record") || path.includes("/checkpoint")) &&
    path.endsWith(".json")
  )
    return "session-record";

  // Session snapshots
  if (path.includes("/session/") && path.endsWith(".json")) return "session";

  // Memory overview
  if (
    path.includes("/memory/") &&
    (path.endsWith("/index.json") || path.endsWith("/overview.json"))
  )
    return "memory-overview";

  // Memory entity
  if (path.includes("/memory/") && path.endsWith(".json")) return "memory-entity";

  // Memory (non-JSON)
  if (path.includes("/memory/")) return "memory";

  // Snapshot overview
  if (
    path.includes("/snapshots/") &&
    (path.endsWith("/index.json") || path.endsWith("/overview.json"))
  )
    return "snapshot-overview";

  // Snapshot chain files
  if (
    path.includes("/snapshots/") &&
    (path.includes("/chain") || path.endsWith("-chain.json")) &&
    path.endsWith(".json")
  )
    return "snapshot-chain";

  // Snapshot node files
  if (
    path.includes("/snapshots/") &&
    (path.includes("/node") || /\/[a-f0-9]{8,}\.json$/.test(path)) &&
    path.endsWith(".json")
  )
    return "snapshot-node";

  // Mailbox files
  if (path.includes("/mailbox/") && path.endsWith(".json")) return "mailbox";

  // Gateway files (session/node already matched above)
  if (path.includes("/gateway/") && path.endsWith(".json")) return "gateway";

  // Scratchpad files
  if (path.includes("/scratchpad/")) return "scratchpad";

  // Workspace files
  if (path.includes("/workspace/") || path.includes("/scratch/")) return "workspace";

  // Generic JSON
  if (path.endsWith(".json") || path.endsWith(".jsonl")) return "json";

  // Text files
  const ext = path.split(".").pop()?.toLowerCase();
  if (
    ext === "md" ||
    ext === "txt" ||
    ext === "log" ||
    ext === "yaml" ||
    ext === "yml" ||
    ext === "toml" ||
    ext === "ts" ||
    ext === "js" ||
    ext === "py"
  )
    return "text";

  return "default";
}

describe("viewer-router path matching", () => {
  test("manifest files route to manifest viewer", () => {
    expect(resolveViewerType("/agents/a1/manifest.json")).toBe("manifest");
    expect(resolveViewerType("/agents/a1/manifest.yaml")).toBe("manifest");
  });

  test("brick files route to brick viewer", () => {
    expect(resolveViewerType("/global/bricks/my-brick.json")).toBe("brick");
    expect(resolveViewerType("/agents/a1/bricks/custom.json")).toBe("brick");
  });

  test("event log files route to event-log viewer", () => {
    expect(resolveViewerType("/agents/a1/events/2024-01-01.jsonl")).toBe("event-log");
    expect(resolveViewerType("/agents/a1/events/latest.json")).toBe("event-log");
  });

  test("session files route to session viewer", () => {
    expect(resolveViewerType("/agents/a1/session/snapshot.json")).toBe("session");
  });

  test("memory files route to memory viewer", () => {
    expect(resolveViewerType("/agents/a1/memory/knowledge.json")).toBe("memory-entity");
    expect(resolveViewerType("/agents/a1/memory/notes.md")).toBe("memory");
  });

  test("gateway files route to gateway viewer", () => {
    expect(resolveViewerType("/global/gateway/topology.json")).toBe("gateway");
  });

  test("workspace files route to workspace viewer", () => {
    expect(resolveViewerType("/agents/a1/workspace/draft.txt")).toBe("workspace");
    expect(resolveViewerType("/agents/a1/scratch/temp.json")).toBe("workspace");
  });

  test("generic JSON files route to json viewer", () => {
    expect(resolveViewerType("/some/config.json")).toBe("json");
    expect(resolveViewerType("/data/log.jsonl")).toBe("json");
  });

  test("text files route to text viewer", () => {
    expect(resolveViewerType("/readme.md")).toBe("text");
    expect(resolveViewerType("/config.yaml")).toBe("text");
    expect(resolveViewerType("/script.ts")).toBe("text");
  });

  test("unknown extensions fall through to default", () => {
    expect(resolveViewerType("/some/file.bin")).toBe("default");
    expect(resolveViewerType("/some/file.png")).toBe("default");
  });

  test("specificity: manifest.json in bricks dir routes to manifest (not brick)", () => {
    // Manifest check comes before brick check
    expect(resolveViewerType("/agents/a1/bricks/manifest.json")).toBe("manifest");
  });

  test("specificity: events/session.json routes to event-log (not session)", () => {
    // Events check comes before session check
    expect(resolveViewerType("/agents/a1/events/session.json")).toBe("event-log");
  });

  // --- New viewer type tests ---

  test("agent overview files route to agent-overview viewer", () => {
    expect(resolveViewerType("/agents/a1/overview.json")).toBe("agent-overview");
    expect(resolveViewerType("/agents/a1/index.json")).toBe("agent-overview");
    expect(resolveViewerType("/agents/my-agent/overview.json")).toBe("agent-overview");
  });

  test("brick list files route to brick-list viewer", () => {
    expect(resolveViewerType("/global/bricks/index.json")).toBe("brick-list");
    expect(resolveViewerType("/agents/a1/bricks/list.json")).toBe("brick-list");
  });

  test("event stream metadata routes to event-stream viewer", () => {
    expect(resolveViewerType("/agents/a1/events/stream.json")).toBe("event-stream");
    expect(resolveViewerType("/agents/a1/events/meta.json")).toBe("event-stream");
  });

  test("event detail files route to event-detail viewer", () => {
    expect(resolveViewerType("/agents/a1/events/evt-001.json")).toBe("event-detail");
    expect(resolveViewerType("/agents/a1/events/evt_abc123.json")).toBe("event-detail");
  });

  test("dead letter queue files route to dead-letter viewer", () => {
    expect(resolveViewerType("/agents/a1/events/dlq/entry-001.json")).toBe("dead-letter");
    expect(resolveViewerType("/global/dead-letter/msg-123.json")).toBe("dead-letter");
  });

  test("subscription files route to subscription viewer", () => {
    expect(resolveViewerType("/agents/a1/subscriptions/my-sub.json")).toBe("subscription");
    expect(resolveViewerType("/agents/a1/subscription-pos.json")).toBe("subscription");
    expect(resolveViewerType("/agents/a1/subscription_state.json")).toBe("subscription");
  });

  test("session record/checkpoint files route to session-record viewer", () => {
    expect(resolveViewerType("/agents/a1/session/record/latest.json")).toBe("session-record");
    expect(resolveViewerType("/agents/a1/session/checkpoint/cp-001.json")).toBe("session-record");
  });

  test("session list files route to session-list viewer", () => {
    expect(resolveViewerType("/agents/a1/session/index.json")).toBe("session-list");
    expect(resolveViewerType("/agents/a1/session/list.json")).toBe("session-list");
    expect(resolveViewerType("/agents/a1/session/sessions.json")).toBe("session-list");
  });

  test("pending frames files route to pending-frames viewer", () => {
    expect(resolveViewerType("/agents/a1/session/pending/frames.json")).toBe("pending-frames");
    expect(resolveViewerType("/agents/a1/pending-frames/current.json")).toBe("pending-frames");
  });

  test("memory overview files route to memory-overview viewer", () => {
    expect(resolveViewerType("/agents/a1/memory/index.json")).toBe("memory-overview");
    expect(resolveViewerType("/agents/a1/memory/overview.json")).toBe("memory-overview");
  });

  test("memory entity files route to memory-entity viewer", () => {
    expect(resolveViewerType("/agents/a1/memory/entity-001.json")).toBe("memory-entity");
    expect(resolveViewerType("/agents/a1/memory/knowledge.json")).toBe("memory-entity");
  });

  test("snapshot overview files route to snapshot-overview viewer", () => {
    expect(resolveViewerType("/agents/a1/snapshots/index.json")).toBe("snapshot-overview");
    expect(resolveViewerType("/agents/a1/snapshots/overview.json")).toBe("snapshot-overview");
  });

  test("snapshot chain files route to snapshot-chain viewer", () => {
    expect(resolveViewerType("/agents/a1/snapshots/chain/main.json")).toBe("snapshot-chain");
    expect(resolveViewerType("/agents/a1/snapshots/state-chain.json")).toBe("snapshot-chain");
  });

  test("snapshot node files route to snapshot-node viewer", () => {
    expect(resolveViewerType("/agents/a1/snapshots/node/abc123.json")).toBe("snapshot-node");
    expect(resolveViewerType("/agents/a1/snapshots/abcdef0123456789.json")).toBe("snapshot-node");
  });

  test("mailbox files route to mailbox viewer", () => {
    expect(resolveViewerType("/agents/a1/mailbox/inbox.json")).toBe("mailbox");
    expect(resolveViewerType("/global/mailbox/outbox.json")).toBe("mailbox");
  });

  test("gateway session files route to gateway-session viewer", () => {
    expect(resolveViewerType("/global/gateway/sessions/sess-001.json")).toBe("gateway-session");
    expect(resolveViewerType("/global/gateway/session/active.json")).toBe("gateway-session");
  });

  test("gateway node files route to gateway-node viewer", () => {
    expect(resolveViewerType("/global/gateway/nodes/node-001.json")).toBe("gateway-node");
    expect(resolveViewerType("/global/gateway/node/primary.json")).toBe("gateway-node");
  });

  test("scratchpad files route to scratchpad viewer", () => {
    expect(resolveViewerType("/agents/a1/scratchpad/notes.json")).toBe("scratchpad");
    expect(resolveViewerType("/agents/a1/scratchpad/draft.txt")).toBe("scratchpad");
  });

  test("specificity: dead letter in events takes priority over event-log", () => {
    expect(resolveViewerType("/agents/a1/events/dlq/failed.json")).toBe("dead-letter");
  });

  test("specificity: stream.json in events routes to event-stream (not event-log)", () => {
    expect(resolveViewerType("/agents/a1/events/stream.json")).toBe("event-stream");
  });

  test("specificity: session index routes to session-list (not session)", () => {
    expect(resolveViewerType("/agents/a1/session/index.json")).toBe("session-list");
  });

  test("specificity: memory index routes to memory-overview (not memory-entity)", () => {
    expect(resolveViewerType("/agents/a1/memory/index.json")).toBe("memory-overview");
  });

  test("specificity: gateway sessions routes to gateway-session (not gateway)", () => {
    expect(resolveViewerType("/global/gateway/sessions/s1.json")).toBe("gateway-session");
  });

  test("specificity: gateway nodes routes to gateway-node (not gateway)", () => {
    expect(resolveViewerType("/global/gateway/nodes/n1.json")).toBe("gateway-node");
  });

  test("specificity: snapshot index routes to snapshot-overview (not snapshot-chain)", () => {
    expect(resolveViewerType("/agents/a1/snapshots/index.json")).toBe("snapshot-overview");
  });

  test("specificity: brick index routes to brick-list (not brick)", () => {
    expect(resolveViewerType("/global/bricks/index.json")).toBe("brick-list");
  });
});
