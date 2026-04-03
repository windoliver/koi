/**
 * SSE connection status indicator — shows a colored dot + label.
 */

import { useConnectionStore } from "../../stores/connection-store.js";
import type { SseConnectionState } from "../../lib/sse-client.js";

const STATE_CONFIG: Readonly<
  Record<SseConnectionState, { readonly color: string; readonly label: string }>
> = {
  connected: { color: "bg-[var(--color-success)]", label: "Connected" },
  reconnecting: { color: "bg-[var(--color-warning)]", label: "Reconnecting..." },
  disconnected: { color: "bg-[var(--color-error)]", label: "Disconnected" },
};

export function ConnectionIndicator(): React.ReactElement {
  const status = useConnectionStore((s) => s.status);
  const config = STATE_CONFIG[status];

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
      <span className={`inline-block h-2 w-2 rounded-full ${config.color}`} />
      {config.label}
    </div>
  );
}
