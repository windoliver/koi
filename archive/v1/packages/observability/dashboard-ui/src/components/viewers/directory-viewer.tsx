/**
 * DirectoryViewer — renders a directory listing when a directory is selected.
 *
 * Uses the file tree hook to fetch entries and displays them in a table.
 * Clicking an entry navigates to it (selecting in tree store).
 * Respects the active saved view's globPattern for consistent filtering.
 */

import { File, Folder } from "lucide-react";
import { useFileTree } from "../../hooks/use-file-tree.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const globPattern = useViewStore((s) => s.activeView.globPattern);
  const { entries, isLoading, error } = useFileTree(
    path,
    globPattern !== undefined ? { glob: globPattern } : undefined,
  );
  const select = useTreeStore((s) => s.select);
  const setExpanded = useTreeStore((s) => s.setExpanded);

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-[var(--color-muted)]">Loading...</div>
    );
  }

  if (error !== null) {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to load directory: {error.message}
      </div>
    );
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Folder className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path}</span>
        <span className="text-xs text-[var(--color-muted)]">
          {entries.length} items
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-sm italic text-[var(--color-muted)]">
            Empty directory
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr
                  key={entry.path}
                  className="cursor-pointer border-b border-[var(--color-border)]/50 hover:bg-[var(--color-muted)]/5"
                  onClick={() => {
                    if (entry.isDirectory) {
                      setExpanded(entry.path, true);
                    }
                    select(entry.path, entry.isDirectory);
                  }}
                >
                  <td className="flex items-center gap-2 px-4 py-2">
                    {entry.isDirectory ? (
                      <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-[var(--color-muted)]">
                    {entry.size !== undefined
                      ? formatSize(entry.size)
                      : "\u2014"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
