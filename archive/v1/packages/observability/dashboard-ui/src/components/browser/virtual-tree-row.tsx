/**
 * VirtualTreeRow — a single row in the virtualized file tree.
 *
 * Renders the same visual as FileTreeNode but without recursive children.
 * Depth-based indentation, expand/collapse chevron, file icon, and name.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import type { FlatTreeItem } from "../../hooks/use-flat-tree.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FileContextMenu } from "./file-context-menu.js";
import { FileIcon } from "./file-icon.js";

export function VirtualTreeRow({
  item,
  index,
  onKeyDown,
}: {
  readonly item: FlatTreeItem;
  readonly index: number;
  readonly onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
}): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const select = useTreeStore((s) => s.select);

  const isSelected = selectedPath === item.path;

  const handleClick = (): void => {
    if (item.isDirectory) {
      toggleExpanded(item.path);
    }
    select(item.path, item.isDirectory);
  };

  return (
    <FileContextMenu path={item.path} isDirectory={item.isDirectory}>
      <button
        type="button"
        data-tree-node
        data-tree-index={index}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => onKeyDown(e, index)}
        className={`flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-[var(--color-muted)]/10 ${
          isSelected ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : ""
        }`}
        style={{ paddingLeft: `${item.depth * 16 + 8}px` }}
      >
        {item.isDirectory ? (
          item.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <FileIcon
          name={item.entry.name}
          isDirectory={item.isDirectory}
          isOpen={item.isExpanded}
          className="h-4 w-4 shrink-0 text-[var(--color-muted)]"
        />
        <span className="truncate">{item.entry.name}</span>
        {item.needsLoad && (
          <span className="ml-auto text-xs text-[var(--color-muted)]">...</span>
        )}
      </button>
    </FileContextMenu>
  );
}
