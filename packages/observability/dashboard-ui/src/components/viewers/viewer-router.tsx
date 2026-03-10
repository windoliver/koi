/**
 * ViewerRouter — routes a file path to the appropriate typed viewer.
 *
 * Pattern matching against path segments and file extensions to select
 * the best viewer for the content type.
 */

import { useFileContent } from "../../hooks/use-file-content.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";
import { BrickViewer } from "./brick-viewer.js";
import { EventLogViewer } from "./event-log-viewer.js";
import { GatewayViewer } from "./gateway-viewer.js";
import { JsonViewer } from "./json-viewer.js";
import { ManifestViewer } from "./manifest-viewer.js";
import { MemoryViewer } from "./memory-viewer.js";
import { SessionViewer } from "./session-viewer.js";
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
  // Manifest files
  {
    match: (p) => p.endsWith("/manifest.json") || p.endsWith("/manifest.yaml"),
    Viewer: ManifestViewer,
  },
  // Brick definitions
  {
    match: (p) => p.includes("/bricks/") && p.endsWith(".json"),
    Viewer: BrickViewer,
  },
  // Event logs (JSONL or JSON in events directories)
  {
    match: (p) => p.includes("/events/") && (p.endsWith(".jsonl") || p.endsWith(".json")),
    Viewer: EventLogViewer,
  },
  // Session snapshots
  {
    match: (p) => p.includes("/session/") && p.endsWith(".json"),
    Viewer: SessionViewer,
  },
  // Memory files
  {
    match: (p) => p.includes("/memory/"),
    Viewer: MemoryViewer,
  },
  // Gateway files
  {
    match: (p) => p.includes("/gateway/") && p.endsWith(".json"),
    Viewer: GatewayViewer,
  },
  // Workspace files
  {
    match: (p) => p.includes("/workspace/") || p.includes("/scratch/"),
    Viewer: WorkspaceViewer,
  },
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
