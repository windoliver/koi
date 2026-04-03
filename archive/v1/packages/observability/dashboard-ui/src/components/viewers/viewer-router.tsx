/**
 * ViewerRouter — routes a file or directory path to the appropriate viewer.
 *
 * Uses regex patterns from the namespace contract (admin-panel.md §5) for path
 * matching. Files load content via useFileContent; directories route to
 * specialized directory viewers or a generic listing.
 *
 * resolveViewerName / resolveDirectoryViewerName are exported for testing.
 */

import { useFileContent } from "../../hooks/use-file-content.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";
import { AgentDirectoryViewer } from "./agent-directory-viewer.js";
import { AgentOverviewViewer } from "./agent-overview-viewer.js";
import { BrickListViewer } from "./brick-list-viewer.js";
import { BrickViewer } from "./brick-viewer.js";
import { DeadLetterViewer } from "./dead-letter-viewer.js";
import { DirectoryViewer } from "./directory-viewer.js";
import { EventDetailViewer } from "./event-detail-viewer.js";
import { EventLogViewer } from "./event-log-viewer.js";
import { EventStreamViewer } from "./event-stream-viewer.js";
import { GatewayDirectoryViewer } from "./gateway-directory-viewer.js";
import { GatewayNodeViewer } from "./gateway-node-viewer.js";
import { GatewaySessionViewer } from "./gateway-session-viewer.js";
import { GatewayViewer } from "./gateway-viewer.js";
import { JsonViewer } from "./json-viewer.js";
import { MailboxDirectoryViewer } from "./mailbox-directory-viewer.js";
import { MailboxViewer } from "./mailbox-viewer.js";
import { ManifestViewer } from "./manifest-viewer.js";
import { MemoryEntityViewer } from "./memory-entity-viewer.js";
import { MemoryOverviewViewer } from "./memory-overview-viewer.js";
import { MemoryViewer } from "./memory-viewer.js";
import {
  BricksDirectoryViewer,
  DeadLetterDirectoryViewer,
  EventStreamsDirectoryViewer,
  EventsDirectoryViewer,
  MemoryDirectoryViewer,
  PendingFramesDirectoryViewer,
  SessionDirectoryViewer,
  SessionRecordsDirectoryViewer,
  SnapshotsDirectoryViewer,
  SubscriptionsDirectoryViewer,
} from "./namespace-directory-viewers.js";
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

// ---------------------------------------------------------------------------
// File viewer rules — regex patterns from admin-panel.md namespace contract
// ---------------------------------------------------------------------------

type FileViewer = React.ComponentType<{
  readonly content: string;
  readonly path: string;
  readonly editable?: boolean;
}>;

const VIEWER_RULES: readonly {
  readonly name: string;
  readonly match: (path: string) => boolean;
  readonly Viewer: FileViewer;
}[] = [
  // === Contract patterns (admin-panel.md §5) ===

  // Manifest files
  {
    name: "manifest",
    match: (p) => /\/manifest\.(json|yaml)$/.test(p),
    Viewer: ManifestViewer,
  },

  // Agent overview/index files
  {
    name: "agent-overview",
    match: (p) => /\/agents\/[^/]+\/(overview|index)\.json$/.test(p),
    Viewer: AgentOverviewViewer,
  },

  // Forge bricks — individual brick files
  {
    name: "brick",
    match: (p) =>
      /^\/(agents\/[^/]+|global)\/bricks\/[^/]+\.json$/.test(p),
    Viewer: BrickViewer,
  },

  // Event stream metadata
  {
    name: "event-stream",
    match: (p) =>
      /\/agents\/[^/]+\/events\/streams\/[^/]+\/meta\.json$/.test(p),
    Viewer: EventStreamViewer,
  },

  // Event detail — numeric stream event files
  {
    name: "event-detail",
    match: (p) =>
      /\/agents\/[^/]+\/events\/streams\/[^/]+\/events\/\d+\.json$/.test(p),
    Viewer: EventDetailViewer,
  },

  // Dead letter entries
  {
    name: "dead-letter",
    match: (p) =>
      /\/agents\/[^/]+\/events\/dead-letters\/[^/]+\.json$/.test(p),
    Viewer: DeadLetterViewer,
  },

  // Subscription files
  {
    name: "subscription",
    match: (p) =>
      /\/agents\/[^/]+\/events\/subscriptions\/[^/]+\.json$/.test(p),
    Viewer: SubscriptionViewer,
  },

  // Session records
  {
    name: "session-record",
    match: (p) =>
      /\/agents\/[^/]+\/session\/records\/[^/]+\.json$/.test(p),
    Viewer: SessionRecordViewer,
  },

  // Pending frames
  {
    name: "pending-frames",
    match: (p) =>
      /\/agents\/[^/]+\/session\/pending\/[^/]+\.json$/.test(p),
    Viewer: PendingFramesViewer,
  },

  // Session files (catch-all under session/)
  {
    name: "session",
    match: (p) => /\/agents\/[^/]+\/session\/[^/]+\.json$/.test(p),
    Viewer: SessionViewer,
  },

  // Memory overview (index/overview files)
  {
    name: "memory-overview",
    match: (p) =>
      /\/agents\/[^/]+\/memory\/(index|overview)\.json$/.test(p),
    Viewer: MemoryOverviewViewer,
  },

  // Memory entities
  {
    name: "memory-entity",
    match: (p) =>
      /\/agents\/[^/]+\/memory\/entities\/[^/]+\.json$/.test(p),
    Viewer: MemoryEntityViewer,
  },

  // Memory files (non-JSON catch-all)
  {
    name: "memory",
    match: (p) => /\/agents\/[^/]+\/memory\//.test(p),
    Viewer: MemoryViewer,
  },

  // Snapshot chain metadata (meta.json per contract)
  {
    name: "snapshot-chain",
    match: (p) =>
      /\/agents\/[^/]+\/snapshots\/[^/]+\/meta\.json$/.test(p),
    Viewer: SnapshotChainViewer,
  },

  // Snapshot overview (index/overview in snapshots root)
  {
    name: "snapshot-overview",
    match: (p) =>
      /\/agents\/[^/]+\/snapshots\/(index|overview)\.json$/.test(p),
    Viewer: SnapshotOverviewViewer,
  },

  // Snapshot node files
  {
    name: "snapshot-node",
    match: (p) =>
      /\/agents\/[^/]+\/snapshots\/[^/]+\/[^/]+\.json$/.test(p),
    Viewer: SnapshotNodeViewer,
  },

  // Mailbox message files
  {
    name: "mailbox",
    match: (p) => /\/agents\/[^/]+\/mailbox\/[^/]+\.json$/.test(p),
    Viewer: MailboxViewer,
  },

  // Gateway sessions
  {
    name: "gateway-session",
    match: (p) => /\/global\/gateway\/sessions\/[^/]+\.json$/.test(p),
    Viewer: GatewaySessionViewer,
  },

  // Gateway nodes
  {
    name: "gateway-node",
    match: (p) => /\/global\/gateway\/nodes\/[^/]+\.json$/.test(p),
    Viewer: GatewayNodeViewer,
  },

  // Gateway files (catch-all under gateway/)
  {
    name: "gateway",
    match: (p) => /\/global\/gateway\/[^/]+\.json$/.test(p),
    Viewer: GatewayViewer,
  },

  // Workspace files
  {
    name: "workspace",
    match: (p) => /\/agents\/[^/]+\/workspace\//.test(p),
    Viewer: WorkspaceViewer,
  },

  // Group scratchpad
  {
    name: "scratchpad",
    match: (p) => /\/groups\/[^/]+\/scratch\//.test(p),
    Viewer: ScratchpadViewer,
  },

  // Event log files (catch-all under events/)
  {
    name: "event-log",
    match: (p) =>
      /\/agents\/[^/]+\/events\//.test(p) && /\.(jsonl?|log)$/.test(p),
    Viewer: EventLogViewer,
  },

  // === Fallback patterns ===

  // Brick list files (index/list in bricks directory)
  {
    name: "brick-list",
    match: (p) =>
      p.includes("/bricks/") &&
      (p.endsWith("/index.json") || p.endsWith("/list.json")),
    Viewer: BrickListViewer,
  },

  // Session list files
  {
    name: "session-list",
    match: (p) =>
      p.includes("/session/") &&
      (p.endsWith("/index.json") ||
        p.endsWith("/list.json") ||
        p.endsWith("/sessions.json")),
    Viewer: SessionListViewer,
  },

  // Generic JSON
  {
    name: "json",
    match: (p) => /\.jsonl?$/.test(p),
    Viewer: JsonViewer,
  },

  // Text files
  {
    name: "text",
    match: (p) => /\.(md|txt|log|yaml|yml|toml|ts|js|py)$/.test(p),
    Viewer: TextViewer,
  },
];

// ---------------------------------------------------------------------------
// Directory viewer rules — regex patterns from admin-panel.md §5
// ---------------------------------------------------------------------------

type DirectoryComponent = React.ComponentType<{ readonly path: string }>;

const DIRECTORY_RULES: readonly {
  readonly name: string;
  readonly match: (path: string) => boolean;
  readonly Component: DirectoryComponent;
}[] = [
  // Agent root — full overview with runtime data + actions
  {
    name: "agent-overview",
    match: (p) => /\/agents\/[^/]+\/?$/.test(p),
    Component: AgentDirectoryViewer,
  },

  // Mailbox — command-backed (listMailbox API)
  {
    name: "mailbox",
    match: (p) => /\/agents\/[^/]+\/mailbox\/?$/.test(p),
    Component: MailboxDirectoryViewer,
  },

  // Bricks (per-agent and global)
  {
    name: "bricks",
    match: (p) => /\/(agents\/[^/]+|global)\/bricks\/?$/.test(p),
    Component: BricksDirectoryViewer,
  },

  // Events root
  {
    name: "events",
    match: (p) => /\/agents\/[^/]+\/events\/?$/.test(p),
    Component: EventsDirectoryViewer,
  },

  // Event streams
  {
    name: "event-streams",
    match: (p) => /\/agents\/[^/]+\/events\/streams\/?$/.test(p),
    Component: EventStreamsDirectoryViewer,
  },

  // Dead-letter queue
  {
    name: "dead-letters",
    match: (p) => /\/agents\/[^/]+\/events\/dead-letters\/?$/.test(p),
    Component: DeadLetterDirectoryViewer,
  },

  // Subscriptions
  {
    name: "subscriptions",
    match: (p) => /\/agents\/[^/]+\/events\/subscriptions\/?$/.test(p),
    Component: SubscriptionsDirectoryViewer,
  },

  // Session root
  {
    name: "session",
    match: (p) => /\/agents\/[^/]+\/session\/?$/.test(p),
    Component: SessionDirectoryViewer,
  },

  // Session records
  {
    name: "session-records",
    match: (p) => /\/agents\/[^/]+\/session\/records\/?$/.test(p),
    Component: SessionRecordsDirectoryViewer,
  },

  // Pending frames (per session)
  {
    name: "pending-frames",
    match: (p) => /\/agents\/[^/]+\/session\/pending\/[^/]+\/?$/.test(p),
    Component: PendingFramesDirectoryViewer,
  },

  // Memory
  {
    name: "memory",
    match: (p) => /\/agents\/[^/]+\/memory\/?$/.test(p),
    Component: MemoryDirectoryViewer,
  },

  // Snapshots
  {
    name: "snapshots",
    match: (p) => /\/agents\/[^/]+\/snapshots\/?$/.test(p),
    Component: SnapshotsDirectoryViewer,
  },

  // Global gateway
  {
    name: "gateway",
    match: (p) => /\/global\/gateway\/?$/.test(p),
    Component: GatewayDirectoryViewer,
  },
];

function resolveViewer(path: string): FileViewer {
  for (const rule of VIEWER_RULES) {
    if (rule.match(path)) return rule.Viewer;
  }
  return TextViewer;
}

function resolveDirectoryViewer(
  path: string,
): DirectoryComponent | undefined {
  for (const rule of DIRECTORY_RULES) {
    if (rule.match(path)) return rule.Component;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exported for testing — returns the rule name that matched
// ---------------------------------------------------------------------------

export function resolveViewerName(path: string): string {
  for (const rule of VIEWER_RULES) {
    if (rule.match(path)) return rule.name;
  }
  return "text";
}

export function resolveDirectoryViewerName(
  path: string,
): string | undefined {
  for (const rule of DIRECTORY_RULES) {
    if (rule.match(path)) return rule.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public component — routes files and directories
// ---------------------------------------------------------------------------

export function ViewerRouter({
  path,
  isDirectory,
}: {
  readonly path: string;
  readonly isDirectory?: boolean;
}): React.ReactElement {
  if (isDirectory === true) {
    return <DirectoryViewerRouter path={path} />;
  }
  return <FileViewerRouter path={path} />;
}

// ---------------------------------------------------------------------------
// File viewer — loads content and routes to typed viewer
// ---------------------------------------------------------------------------

function FileViewerRouter({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const { content, editable, isLoading, error } = useFileContent(path);

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
          <div className="text-sm font-medium text-red-500">
            Failed to load file
          </div>
          <div className="mt-1 text-xs text-[var(--color-muted)]">
            {error.message}
          </div>
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
  return <Viewer content={content} path={path} editable={editable} />;
}

// ---------------------------------------------------------------------------
// Directory viewer — matches against DIRECTORY_RULES, falls back to listing
// ---------------------------------------------------------------------------

function DirectoryViewerRouter({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const SpecializedViewer = resolveDirectoryViewer(path);
  if (SpecializedViewer !== undefined) {
    return <SpecializedViewer path={path} />;
  }
  return <DirectoryViewer path={path} />;
}
