/**
 * Tests for viewer routing logic — verifies path → viewer mapping.
 */

import { describe, expect, test } from "bun:test";

// Extract the match logic as a pure function for testing
// (mirrors VIEWER_RULES from viewer-router.tsx)
type ViewerType =
  | "manifest"
  | "brick"
  | "event-log"
  | "session"
  | "memory"
  | "gateway"
  | "workspace"
  | "json"
  | "text"
  | "default";

function resolveViewerType(path: string): ViewerType {
  if (path.endsWith("/manifest.json") || path.endsWith("/manifest.yaml")) return "manifest";
  if (path.includes("/bricks/") && path.endsWith(".json")) return "brick";
  if (path.includes("/events/") && (path.endsWith(".jsonl") || path.endsWith(".json")))
    return "event-log";
  if (path.includes("/session/") && path.endsWith(".json")) return "session";
  if (path.includes("/memory/")) return "memory";
  if (path.includes("/gateway/") && path.endsWith(".json")) return "gateway";
  if (path.includes("/workspace/") || path.includes("/scratch/")) return "workspace";
  if (path.endsWith(".json") || path.endsWith(".jsonl")) return "json";

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
    expect(resolveViewerType("/agents/a1/memory/knowledge.json")).toBe("memory");
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
});
