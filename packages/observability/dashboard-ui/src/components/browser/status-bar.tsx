/**
 * StatusBar — bottom bar showing file metadata and connection status.
 */

import { useTreeStore } from "../../stores/tree-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useViewStore } from "../../stores/view-store.js";

export function StatusBar(): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const connectionStatus = useConnectionStore((s) => s.status);
  const activeView = useViewStore((s) => s.activeView);

  const statusColor =
    connectionStatus === "connected"
      ? "text-green-500"
      : connectionStatus === "reconnecting"
        ? "text-yellow-500"
        : "text-red-500";

  return (
    <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)]">
      <div className="flex items-center gap-3">
        <span>View: {activeView.label}</span>
        {selectedPath !== null && (
          <span className="truncate max-w-xs">{selectedPath}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
        <span>{connectionStatus}</span>
      </div>
    </div>
  );
}
