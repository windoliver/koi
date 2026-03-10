/**
 * FileContextMenu — right-click context menu for file tree items.
 *
 * Simple custom implementation using fixed positioning.
 * Dismisses on click outside or Escape key.
 */

import { useCallback, useEffect, useRef } from "react";
import { deleteFsFile } from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";

interface FileContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly onClose: () => void;
}

export function FileContextMenu({
  x,
  y,
  path,
  isDirectory,
  onClose,
}: FileContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const select = useTreeStore((s) => s.select);
  const invalidateTree = useTreeStore((s) => s.invalidateTree);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    // Use capture so we handle the event before the click propagates
    document.addEventListener("mousedown", handleClickOutside, true);
    return () =>
      document.removeEventListener("mousedown", handleClickOutside, true);
  }, [onClose]);

  const handleOpen = useCallback((): void => {
    if (!isDirectory) {
      select(path);
    }
    onClose();
  }, [isDirectory, path, select, onClose]);

  const handleCopyPath = useCallback((): void => {
    void navigator.clipboard.writeText(path);
    onClose();
  }, [path, onClose]);

  const handleRefresh = useCallback((): void => {
    invalidateTree();
    onClose();
  }, [invalidateTree, onClose]);

  const handleDelete = useCallback((): void => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${path}"?`,
    );
    if (confirmed) {
      void deleteFsFile(path).then(() => {
        invalidateTree();
      });
    }
    onClose();
  }, [path, invalidateTree, onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {!isDirectory && (
        <ContextMenuItem label="Open" onClick={handleOpen} />
      )}
      <ContextMenuItem label="Copy Path" onClick={handleCopyPath} />
      <ContextMenuItem label="Refresh" onClick={handleRefresh} />
      <div className="my-1 border-t border-[var(--color-border)]" />
      <ContextMenuItem label="Delete" onClick={handleDelete} destructive />
    </div>
  );
}

function ContextMenuItem({
  label,
  onClick,
  destructive,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly destructive?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--color-muted)]/10 ${
        destructive === true ? "text-red-500" : ""
      }`}
    >
      {label}
    </button>
  );
}
