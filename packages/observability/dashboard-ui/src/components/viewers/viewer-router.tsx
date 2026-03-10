/**
 * ViewerRouter — routes a file path to the appropriate typed viewer.
 *
 * Pattern matching against path segments and file extensions to select
 * the best viewer for the content type.
 */

import { useFileContent } from "../../hooks/use-file-content.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";
import { AgentOverviewViewer } from "./agent-overview-viewer.js";
import { BrickListViewer } from "./brick-list-viewer.js";
import { BrickViewer } from "./brick-viewer.js";
import { DeadLetterViewer } from "./dead-letter-viewer.js";
import { EventDetailViewer } from "./event-detail-viewer.js";
import { EventLogViewer } from "./event-log-viewer.js";
import { EventStreamViewer } from "./event-stream-viewer.js";
import { GatewayNodeViewer } from "./gateway-node-viewer.js";
import { GatewaySessionViewer } from "./gateway-session-viewer.js";
import { GatewayViewer } from "./gateway-viewer.js";
import { JsonViewer } from "./json-viewer.js";
import { MailboxViewer } from "./mailbox-viewer.js";
import { ManifestViewer } from "./manifest-viewer.js";
import { MemoryEntityViewer } from "./memory-entity-viewer.js";
import { MemoryOverviewViewer } from "./memory-overview-viewer.js";
import { MemoryViewer } from "./memory-viewer.js";
import { PendingFramesViewer } from "./pending-frames-viewer.js";
import { ScratchpadViewer } from "./scratchpad-viewer.js";
import { SessionListViewer } from "./session-list-viewer.js";
import { SessionRecordViewer } from "./session-record-viewer.js";
import { SessionViewer } from "./session-viewer.js";
import { SnapshotChainViewer } from "./snapshot-chain-viewer.js";
import { SnapshotNodeViewer } from "./snapshot-node-viewer.js";
import { SnapshotOverviewViewer } from "./snapshot-overview-viewer.js";
import { SubscriptionViewer } from "./subscription-viewer.js";
import { TextViewer } from "./text-viewer.js";
import { WorkspaceViewer } from "./workspace-viewer.js";

/**
 * Viewer routing rules — ordered by specificity (most specific first).
 * Each rule has a `match` function and a `viewer` component.
 */
const VIEWER_RULES: readonly {
  readonly match: (path: string) => boolean;
  readonly Viewer: React.ComponentType<{ readonly content: string; readonly path: string }>;
}[] = [
  // === Most specific rules first ===

  // Manifest files (before any directory-based matchers)
  {
    match: (p) => p.endsWith("/manifest.json") || p.endsWith("/manifest.yaml"),
    Viewer: ManifestViewer,
  },

  // Agent overview — agent namespace manifest.json (matched above) serves as overview
  // Also match agent overview/index files specifically
  {
    match: (p) => /\/agents\/[^/]+\/overview\.json$/.test(p) || /\/agents\/[^/]+\/index\.json$/.test(p),
    Viewer: AgentOverviewViewer,
  },

  // Dead letter queue entries (before general events match)
  {
    match: (p) => (p.includes("/events/dlq/") || p.includes("/dead-letter/")) && p.endsWith(".json"),
    Viewer: DeadLetterViewer,
  },

  // Event stream metadata (before general events match)
  {
    match: (p) => p.includes("/events/") && (p.endsWith("/stream.json") || p.endsWith("/meta.json")),
    Viewer: EventStreamViewer,
  },

  // Event detail — individual event files in events directory (e.g., /events/evt-001.json)
  {
    match: (p) => p.includes("/events/") && /\/evt[_-]/.test(p) && p.endsWith(".json"),
    Viewer: EventDetailViewer,
  },

  // Brick list — index/listing files in bricks directory
  {
    match: (p) => p.includes("/bricks/") && (p.endsWith("/index.json") || p.endsWith("/list.json")),
    Viewer: BrickListViewer,
  },

  // Brick definitions (individual brick files)
  {
    match: (p) => p.includes("/bricks/") && p.endsWith(".json"),
    Viewer: BrickViewer,
  },

  // Event logs (JSONL or JSON in events directories)
  {
    match: (p) => p.includes("/events/") && (p.endsWith(".jsonl") || p.endsWith(".json")),
    Viewer: EventLogViewer,
  },

  // Subscription position files
  {
    match: (p) =>
      (p.includes("/subscriptions/") && p.endsWith(".json")) ||
      /\/subscription[_-]?[^/]*\.json$/.test(p),
    Viewer: SubscriptionViewer,
  },

  // Gateway session files (before general session match — /gateway/session/ contains /session/)
  {
    match: (p) =>
      (p.includes("/gateway/sessions/") || p.includes("/gateway/session/")) && p.endsWith(".json"),
    Viewer: GatewaySessionViewer,
  },

  // Gateway node files (before general gateway match)
  {
    match: (p) =>
      (p.includes("/gateway/nodes/") || p.includes("/gateway/node/")) && p.endsWith(".json"),
    Viewer: GatewayNodeViewer,
  },

  // Pending frames (before general session match)
  {
    match: (p) =>
      (p.includes("/session/pending/") || p.includes("/pending-frames")) && p.endsWith(".json"),
    Viewer: PendingFramesViewer,
  },

  // Session list — session index/listing files
  {
    match: (p) =>
      p.includes("/session/") &&
      (p.endsWith("/index.json") || p.endsWith("/list.json") || p.endsWith("/sessions.json")),
    Viewer: SessionListViewer,
  },

  // Session record — session checkpoint/record files
  {
    match: (p) =>
      p.includes("/session/") &&
      (p.includes("/record") || p.includes("/checkpoint")) &&
      p.endsWith(".json"),
    Viewer: SessionRecordViewer,
  },

  // Session snapshots (existing general session viewer)
  {
    match: (p) => p.includes("/session/") && p.endsWith(".json"),
    Viewer: SessionViewer,
  },

  // Memory overview — index/overview files in memory directory
  {
    match: (p) =>
      p.includes("/memory/") &&
      (p.endsWith("/index.json") || p.endsWith("/overview.json")),
    Viewer: MemoryOverviewViewer,
  },

  // Memory entity — specific entity files in memory directory
  {
    match: (p) => p.includes("/memory/") && p.endsWith(".json"),
    Viewer: MemoryEntityViewer,
  },

  // Memory files (non-JSON, existing generic viewer)
  {
    match: (p) => p.includes("/memory/"),
    Viewer: MemoryViewer,
  },

  // Snapshot overview — index/overview in snapshots directory
  {
    match: (p) =>
      p.includes("/snapshots/") &&
      (p.endsWith("/index.json") || p.endsWith("/overview.json")),
    Viewer: SnapshotOverviewViewer,
  },

  // Snapshot chain files
  {
    match: (p) =>
      p.includes("/snapshots/") &&
      (p.includes("/chain") || p.endsWith("-chain.json")) &&
      p.endsWith(".json"),
    Viewer: SnapshotChainViewer,
  },

  // Snapshot node files — individual snapshot nodes
  {
    match: (p) =>
      p.includes("/snapshots/") &&
      (p.includes("/node") || /\/[a-f0-9]{8,}\.json$/.test(p)) &&
      p.endsWith(".json"),
    Viewer: SnapshotNodeViewer,
  },

  // Mailbox files
  {
    match: (p) => p.includes("/mailbox/") && p.endsWith(".json"),
    Viewer: MailboxViewer,
  },

  // Gateway files (existing general gateway viewer — session/node already matched above)
  {
    match: (p) => p.includes("/gateway/") && p.endsWith(".json"),
    Viewer: GatewayViewer,
  },

  // Scratchpad files
  {
    match: (p) => p.includes("/scratchpad/"),
    Viewer: ScratchpadViewer,
  },

  // Workspace files
  {
    match: (p) => p.includes("/workspace/") || p.includes("/scratch/"),
    Viewer: WorkspaceViewer,
  },

  // === Catch-all rules ===

  // Generic JSON
  {
    match: (p) => p.endsWith(".json") || p.endsWith(".jsonl"),
    Viewer: JsonViewer,
  },
  // Text files (catch-all for known text extensions)
  {
    match: (p) => {
      const ext = p.split(".").pop()?.toLowerCase();
      return (
        ext === "md" ||
        ext === "txt" ||
        ext === "log" ||
        ext === "yaml" ||
        ext === "yml" ||
        ext === "toml" ||
        ext === "ts" ||
        ext === "js" ||
        ext === "py"
      );
    },
    Viewer: TextViewer,
  },
];

function resolveViewer(
  path: string,
): React.ComponentType<{ readonly content: string; readonly path: string }> {
  for (const rule of VIEWER_RULES) {
    if (rule.match(path)) return rule.Viewer;
  }
  // Default: text viewer
  return TextViewer;
}

export function ViewerRouter({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const { content, isLoading, error } = useFileContent(path);

  if (isLoading) {
    return (
      <div className="p-6">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-sm font-medium text-red-500">Failed to load file</div>
          <div className="mt-1 text-xs text-[var(--color-muted)]">{error.message}</div>
          <div className="mt-2 text-xs text-[var(--color-muted)]">{path}</div>
        </div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-[var(--color-muted)]">
        No content
      </div>
    );
  }

  const Viewer = resolveViewer(path);
  return <Viewer content={content} path={path} />;
}
