/**
 * OrchestrationDrawer — slide-out panel with 4 tabs for runtime orchestration data.
 *
 * Tabs: Temporal, Scheduler, Task Board, Harness.
 * Each tab is only visible when its data source is available (graceful degradation).
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { DashboardCapabilities } from "../../lib/api-client.js";
import { fetchHealth } from "../../lib/api-client.js";
import { useOrchestrationStore } from "../../stores/orchestration-store.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";

// Lazy-load tab contents — drawer is hidden by default so this avoids
// pulling ReactFlow + orchestration code into the initial bundle (Decision 16A).
const TemporalTab = lazy(() =>
  import("./temporal-tab.js").then((m) => ({ default: m.TemporalTab })),
);
const SchedulerTab = lazy(() =>
  import("./scheduler-tab.js").then((m) => ({ default: m.SchedulerTab })),
);
const TaskDagTab = lazy(() =>
  import("./task-dag-tab.js").then((m) => ({ default: m.TaskDagTab })),
);
const HarnessTab = lazy(() =>
  import("./harness-tab.js").then((m) => ({ default: m.HarnessTab })),
);

type TabId = "temporal" | "scheduler" | "taskboard" | "harness";

interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
}

const TABS: readonly TabDefinition[] = [
  { id: "temporal", label: "Temporal" },
  { id: "scheduler", label: "Scheduler" },
  { id: "taskboard", label: "Task Board" },
  { id: "harness", label: "Harness" },
] as const;

function TabContent({ tabId }: { readonly tabId: TabId }): React.ReactElement {
  return (
    <Suspense fallback={<div className="p-4"><LoadingSkeleton /></div>}>
      {tabId === "temporal" && <TemporalTab />}
      {tabId === "scheduler" && <SchedulerTab />}
      {tabId === "taskboard" && <TaskDagTab />}
      {tabId === "harness" && <HarnessTab />}
    </Suspense>
  );
}

export function OrchestrationDrawer({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): React.ReactElement | null {
  const [activeTab, setActiveTab] = useState<TabId>("temporal");
  const [capabilities, setCapabilities] = useState<DashboardCapabilities | undefined>(undefined);
  const setCommandsDetail = useOrchestrationStore((s) => s.setCommandsDetail);

  // Fetch capabilities once when drawer opens
  useEffect(() => {
    if (!open) return;
    void fetchHealth()
      .then((health) => {
        setCapabilities(health.capabilities);
        setCommandsDetail(health.capabilities?.commandsDetail ?? null);
      })
      .catch(() => {
        // Health probe failed — degrade to empty orchestration views
        setCapabilities({
          fileSystem: false,
          runtimeViews: false,
          commands: false,
          orchestration: { temporal: false, scheduler: false, taskBoard: false, harness: false },
        });
        setCommandsDetail(null);
      });
  }, [open, setCommandsDetail]);

  // Show only tabs whose backing orchestration sources are present
  const visibleTabs = useMemo(() => {
    if (capabilities === undefined) return TABS;
    if (!capabilities.runtimeViews) return [];
    const orch = capabilities.orchestration;
    return TABS.filter((tab) => {
      switch (tab.id) {
        case "temporal": return orch.temporal;
        case "scheduler": return orch.scheduler;
        case "taskboard": return orch.taskBoard;
        case "harness": return orch.harness;
        default: return false;
      }
    });
  }, [capabilities]);

  // Reset active tab if it's no longer visible
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((t) => t.id === activeTab)) {
      const first = visibleTabs[0];
      if (first !== undefined) setActiveTab(first.id);
    }
  }, [visibleTabs, activeTab]);

  // Close drawer on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="Close drawer"
      />

      {/* Drawer panel — full width on mobile, 600px on sm+ */}
      <div className="relative z-10 flex h-full w-full flex-col bg-[var(--color-background,#1e1e2e)] border-l border-[var(--color-border,#444)] sm:w-[600px] sm:max-w-[90vw]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border,#444)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-foreground,#cdd6f4)]">
            Orchestration
          </h2>
          <button
            type="button"
            className="rounded p-1 text-[var(--color-muted,#888)] hover:bg-[var(--color-card,#313244)] hover:text-[var(--color-foreground,#cdd6f4)]"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {visibleTabs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-[var(--color-muted,#888)]">
            Orchestration views not available
          </div>
        ) : (
          <>
            {/* Tab bar */}
            <div className="flex border-b border-[var(--color-border,#444)]">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                    activeTab === tab.id
                      ? "border-b-2 border-[var(--color-primary,#89b4fa)] text-[var(--color-primary,#89b4fa)]"
                      : "text-[var(--color-muted,#888)] hover:text-[var(--color-foreground,#cdd6f4)]"
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">
              <TabContent tabId={activeTab} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
