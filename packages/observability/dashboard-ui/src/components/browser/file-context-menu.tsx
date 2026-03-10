/**
 * FileContextMenu — right-click context menu for file tree items.
 *
 * Wraps children with a Radix ContextMenu trigger so right-click
 * opens a styled menu with file/directory actions.
 */

import * as ContextMenu from "@radix-ui/react-context-menu";
import { useCallback, useState } from "react";
import { deleteFsFile } from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { ConfirmDialog } from "../shared/confirm-dialog.js";

interface FileContextMenuProps {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly children: React.ReactNode;
}

export function FileContextMenu({
  path,
  isDirectory,
  children,
}: FileContextMenuProps): React.ReactElement {
  const select = useTreeStore((s) => s.select);
  const invalidateTree = useTreeStore((s) => s.invalidateTree);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleOpen = useCallback((): void => {
    if (!isDirectory) {
      select(path);
    }
  }, [isDirectory, path, select]);

  const handleCopyPath = useCallback((): void => {
    void navigator.clipboard.writeText(path);
  }, [path]);

  const handleRefresh = useCallback((): void => {
    invalidateTree();
  }, [invalidateTree]);

  const handleDeleteRequest = useCallback((): void => {
    setConfirmOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback((): void => {
    setConfirmOpen(false);
    void deleteFsFile(path).then(() => {
      invalidateTree();
    });
  }, [path, invalidateTree]);

  const handleDeleteCancel = useCallback((): void => {
    setConfirmOpen(false);
  }, []);

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-1 shadow-lg">
            {!isDirectory && (
              <ContextMenu.Item
                className="rounded-sm px-3 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--color-muted)]/10"
                onSelect={handleOpen}
              >
                Open
              </ContextMenu.Item>
            )}
            <ContextMenu.Item
              className="rounded-sm px-3 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--color-muted)]/10"
              onSelect={handleCopyPath}
            >
              Copy Path
            </ContextMenu.Item>
            <ContextMenu.Item
              className="rounded-sm px-3 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-[var(--color-muted)]/10"
              onSelect={handleRefresh}
            >
              Refresh
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-[var(--color-border)]" />
            <ContextMenu.Item
              className="rounded-sm px-3 py-1.5 text-sm cursor-pointer outline-none text-red-500 data-[highlighted]:bg-[var(--color-muted)]/10"
              onSelect={handleDeleteRequest}
            >
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete file"
        description={`Are you sure you want to delete "${path}"?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </>
  );
}
