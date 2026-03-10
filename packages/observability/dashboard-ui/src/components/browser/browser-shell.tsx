/**
 * BrowserShell — main layout for the Nexus namespace browser.
 *
 * Split panel: left sidebar (search + view tabs + file tree) and
 * right content area (breadcrumb + viewer).
 */

import { FolderTree } from "lucide-react";
import { useTreeStore } from "../../stores/tree-store.js";
import { ViewerRouter } from "../viewers/viewer-router.js";
import { Breadcrumb } from "./breadcrumb.js";
import { CommandBar } from "./command-bar.js";
import { FileTree } from "./file-tree.js";
import { SavedViewTabs } from "./saved-view-tabs.js";
import { StatusBar } from "./status-bar.js";

export function BrowserShell(): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: search + tabs + file tree */}
        <div className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)]">
          <CommandBar />
          <SavedViewTabs />
          <FileTree />
        </div>

        {/* Right content area: breadcrumb + viewer */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Breadcrumb />
          <div className="flex-1 overflow-auto">
            {selectedPath !== null ? (
              <ViewerRouter path={selectedPath} />
            ) : (
              <EmptyState />
            )}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <FolderTree className="mx-auto h-12 w-12 text-[var(--color-muted)]/40" />
        <h2 className="mt-4 text-sm font-medium text-[var(--color-foreground)]">
          Nexus Namespace Browser
        </h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Select a file from the tree to view its contents.
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Use the search bar or saved views to filter files.
        </p>
      </div>
    </div>
  );
}
