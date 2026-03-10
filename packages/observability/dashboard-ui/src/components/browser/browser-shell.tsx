/**
 * BrowserShell — main layout for the Nexus namespace browser.
 *
 * Resizable split panel: left sidebar (search + view tabs + file tree) and
 * right content area (breadcrumb + viewer). Uses react-resizable-panels.
 *
 * Responsive:
 * - Desktop: horizontal split panel
 * - Mobile (<768px): stacked layout — tree panel hidden, viewer fills space.
 *   Users navigate via the breadcrumb or a mobile tree toggle.
 */

import { FolderTree, Layers, PanelLeftOpen } from "lucide-react";
import { useCallback, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useKeyboardShortcuts } from "../../hooks/use-keyboard-shortcuts.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { OrchestrationDrawer } from "../orchestration/orchestration-drawer.js";
import { ViewerRouter } from "../viewers/viewer-router.js";
import { Breadcrumb } from "./breadcrumb.js";
import { CommandBar } from "./command-bar.js";
import { FileTree } from "./file-tree.js";
import { SavedViewTabs } from "./saved-view-tabs.js";
import { StatusBar } from "./status-bar.js";

export function BrowserShell(): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const selectedIsDirectory = useTreeStore((s) => s.selectedIsDirectory);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useKeyboardShortcuts({
    drawerOpen,
    onCloseDrawer: closeDrawer,
  });

  return (
    <div className="flex h-full flex-col">
      {/* Desktop: horizontal split panel */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" className="flex-1">
          {/* Left sidebar: search + tabs + file tree */}
          <Panel defaultSize={25} minSize={15} maxSize={50}>
            <div className="flex h-full flex-col border-r border-[var(--color-border)]">
              <CommandBar />
              <SavedViewTabs />
              <FileTree />
              {/* Orchestration drawer toggle */}
              <button
                type="button"
                className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)] hover:bg-[var(--color-card)] hover:text-[var(--color-foreground)] transition-colors"
                onClick={() => setDrawerOpen(true)}
              >
                <Layers className="h-3.5 w-3.5" />
                Orchestration
              </button>
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
      </div>

      {/* Mobile: stacked layout */}
      <div className="flex flex-1 flex-col overflow-hidden md:hidden">
        {/* Mobile tree toggle + breadcrumb */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1">
          <button
            type="button"
            className="rounded p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            onClick={() => setMobileTreeOpen((prev) => !prev)}
            aria-label={mobileTreeOpen ? "Hide file tree" : "Show file tree"}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <div className="flex-1 overflow-hidden">
            <Breadcrumb />
          </div>
        </div>

        {/* Conditionally show tree or viewer on mobile */}
        {mobileTreeOpen ? (
          <div className="flex flex-1 flex-col overflow-hidden border-b border-[var(--color-border)]">
            <CommandBar />
            <SavedViewTabs />
            <FileTree />
            <button
              type="button"
              className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)] hover:bg-[var(--color-card)] hover:text-[var(--color-foreground)] transition-colors"
              onClick={() => setDrawerOpen(true)}
            >
              <Layers className="h-3.5 w-3.5" />
              Orchestration
            </button>
          </div>
        ) : (
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
        )}
      </div>

      <StatusBar />
      <OrchestrationDrawer open={drawerOpen} onClose={closeDrawer} />
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center px-4">
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
