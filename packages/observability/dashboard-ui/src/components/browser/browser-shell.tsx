/**
 * BrowserShell — main layout for the Nexus namespace browser.
 *
 * Resizable split panel: left sidebar (search + view tabs + file tree) and
 * right content area (breadcrumb + viewer). Uses react-resizable-panels.
 */

import { FolderTree } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTreeStore } from "../../stores/tree-store.js";
import { ViewerRouter } from "../viewers/viewer-router.js";
import { Breadcrumb } from "./breadcrumb.js";
import { CommandBar } from "./command-bar.js";
import { FileTree } from "./file-tree.js";
import { SavedViewTabs } from "./saved-view-tabs.js";
import { StatusBar } from "./status-bar.js";

export function BrowserShell(): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const selectedIsDirectory = useTreeStore((s) => s.selectedIsDirectory);

  return (
    <div className="flex h-full flex-col">
      <PanelGroup direction="horizontal" className="flex-1">
        {/* Left sidebar: search + tabs + file tree */}
        <Panel defaultSize={25} minSize={15} maxSize={50}>
          <div className="flex h-full flex-col border-r border-[var(--color-border)]">
            <CommandBar />
            <SavedViewTabs />
            <FileTree />
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-primary)]/30 transition-colors" />

        {/* Right content area: breadcrumb + viewer */}
        <Panel defaultSize={75} minSize={30}>
          <div className="flex h-full flex-col overflow-hidden">
            <Breadcrumb />
            <div className="flex-1 overflow-auto">
              {selectedPath !== null ? (
                <ViewerRouter
                  path={selectedPath}
                  isDirectory={selectedIsDirectory}
                />
              ) : (
                <EmptyState />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
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
