/**
 * FileTreeNode — a single row in the file tree sidebar.
 *
 * Directories are expandable; files are selectable.
 * Uses tree store for expanded/selected state.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import type { FsEntry } from "../../lib/api-client.js";
import { useFileTree } from "../../hooks/use-file-tree.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FileIcon } from "./file-icon.js";

export function FileTreeNode({
  entry,
  depth,
}: {
  readonly entry: FsEntry;
  readonly depth: number;
}): React.ReactElement {
  const expanded = useTreeStore((s) => s.expanded);
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const select = useTreeStore((s) => s.select);

  const isExpanded = expanded.has(entry.path);
  const isSelected = selectedPath === entry.path;

  const handleClick = (): void => {
    if (entry.isDirectory) {
      toggleExpanded(entry.path);
    } else {
      select(entry.path);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={`flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-[var(--color-muted)]/10 ${
          isSelected ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : ""
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {entry.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <FileIcon
          name={entry.name}
          isDirectory={entry.isDirectory}
          isOpen={isExpanded}
          className="h-4 w-4 shrink-0 text-[var(--color-muted)]"
        />
        <span className="truncate">{entry.name}</span>
      </button>
      {entry.isDirectory && isExpanded && (
        <DirectoryChildren path={entry.path} depth={depth + 1} />
      )}
    </div>
  );
}

/** Lazily loads children when a directory is expanded. */
function DirectoryChildren({
  path,
  depth,
}: {
  readonly path: string;
  readonly depth: number;
}): React.ReactElement {
  const { entries, isLoading, error } = useFileTree(path);

  if (isLoading) {
    return (
      <div
        className="px-2 py-1 text-xs text-[var(--color-muted)]"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        Loading...
      </div>
    );
  }

  if (error !== null) {
    return (
      <div
        className="px-2 py-1 text-xs text-red-500"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        Error loading
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        className="px-2 py-1 text-xs text-[var(--color-muted)] italic"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        Empty
      </div>
    );
  }

  // Sort: directories first, then alphabetically
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      {sorted.map((child) => (
        <FileTreeNode key={child.path} entry={child} depth={depth} />
      ))}
    </div>
  );
}
