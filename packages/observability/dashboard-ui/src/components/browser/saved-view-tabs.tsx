/**
 * SavedViewTabs — horizontal tab bar for switching between saved views.
 *
 * Each tab filters the file tree to a different subset of the Nexus namespace.
 */

import { SAVED_VIEWS } from "@koi/dashboard-types";
import { useViewStore } from "../../stores/view-store.js";

export function SavedViewTabs(): React.ReactElement {
  const activeViewId = useViewStore((s) => s.activeViewId);
  const setActiveView = useViewStore((s) => s.setActiveView);

  return (
    <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2 py-1">
      {SAVED_VIEWS.map((view) => (
        <button
          key={view.id}
          type="button"
          onClick={() => setActiveView(view.id)}
          className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            activeViewId === view.id
              ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          }`}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}
