/**
 * Typed directory viewers for namespace subdirectories.
 *
 * Each viewer renders a domain-specific header and directory listing
 * per the admin-panel.md §5 namespace contract.
 */

import {
  AlertTriangle,
  Bell,
  Box,
  Brain,
  Clock,
  Database,
  File,
  Folder,
  GitBranch,
  Layers,
  Zap,
} from "lucide-react";
import { useFileTree } from "../../hooks/use-file-tree.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";

// ---------------------------------------------------------------------------
// Shared typed directory listing base
// ---------------------------------------------------------------------------

function TypedDirectoryListing({
  path,
  title,
  icon: Icon,
  description,
}: {
  readonly path: string;
  readonly title: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly description?: string;
}): React.ReactElement {
  const globPattern = useViewStore((s) => s.activeView.globPattern);
  const { entries, isLoading, error } = useFileTree(
    path,
    globPattern !== undefined ? { glob: globPattern } : undefined,
  );
  const select = useTreeStore((s) => s.select);
  const setExpanded = useTreeStore((s) => s.setExpanded);

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Icon className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{title}</span>
        {!isLoading && (
          <span className="text-xs text-[var(--color-muted)]">
            {entries.length} items
          </span>
        )}
      </div>
      {description !== undefined && (
        <div className="border-b border-[var(--color-border)]/50 px-4 py-2 text-xs text-[var(--color-muted)]">
          {description}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-sm text-[var(--color-muted)]">
            Loading...
          </div>
        ) : error !== null ? (
          <div className="p-4 text-sm text-red-500">
            Failed to load: {error.message}
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-4 text-sm italic text-[var(--color-muted)]">
            Empty
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]/50">
            {sorted.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-[var(--color-muted)]/5"
                onClick={() => {
                  if (entry.isDirectory) setExpanded(entry.path, true);
                  select(entry.path, entry.isDirectory);
                }}
              >
                {entry.isDirectory ? (
                  <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                ) : (
                  <File className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bricks
// ---------------------------------------------------------------------------

export function BricksDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Bricks"
      icon={Box}
      description="Forge brick definitions and verification artifacts"
    />
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function EventsDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Events"
      icon={Zap}
      description="Event streams, dead-letter queue, and subscriptions"
    />
  );
}

export function EventStreamsDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Event Streams"
      icon={Layers}
      description="Named event streams with ordered event sequences"
    />
  );
}

export function DeadLetterDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Dead-Letter Queue"
      icon={AlertTriangle}
      description="Failed events awaiting retry or manual intervention"
    />
  );
}

export function SubscriptionsDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Subscriptions"
      icon={Bell}
      description="Event stream subscription positions and state"
    />
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function SessionDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Session"
      icon={Clock}
      description="Agent session records, checkpoints, and pending frames"
    />
  );
}

export function SessionRecordsDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Session Records"
      icon={Database}
      description="Per-session checkpoint records"
    />
  );
}

export function PendingFramesDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Pending Frames"
      icon={Layers}
      description="Unprocessed session frames awaiting commit"
    />
  );
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function MemoryDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Memory"
      icon={Brain}
      description="Agent memory entities and knowledge store"
    />
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function SnapshotsDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  return (
    <TypedDirectoryListing
      path={path}
      title="Snapshot Chains"
      icon={GitBranch}
      description="Version-controlled snapshot chains with DAG structure"
    />
  );
}
