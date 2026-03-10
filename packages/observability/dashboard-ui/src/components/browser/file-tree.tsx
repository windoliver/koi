/**
 * FileTree — root component for the file tree sidebar.
 *
 * Renders the top-level entries based on the active saved view's root paths.
 * Each root path creates a section in the tree.
 */

import { useFileTree } from "../../hooks/use-file-tree.js";
import { useViewStore } from "../../stores/view-store.js";
import { FileTreeNode } from "./file-tree-node.js";

export function FileTree(): React.ReactElement {
  const activeView = useViewStore((s) => s.activeView);

  return (
    <div data-tree-root className="flex-1 overflow-y-auto py-1">
      {activeView.rootPaths.map((rootPath) => (
        <RootSection key={rootPath} path={rootPath} />
      ))}
    </div>
  );
}

function RootSection({ path }: { readonly path: string }): React.ReactElement {
  const { entries, isLoading, error } = useFileTree(path);

  if (isLoading) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-muted)]">Loading {path}...</div>
    );
  }

  if (error !== null) {
    return (
      <div className="px-3 py-2 text-xs text-red-500">
        Failed to load {path}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-muted)] italic">
        {path} — empty
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
      {sorted.map((entry) => (
        <FileTreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
