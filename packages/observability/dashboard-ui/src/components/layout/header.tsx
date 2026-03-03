/**
 * Top header bar with connection status indicator.
 */

import { ConnectionIndicator } from "../shared/connection-indicator.js";

export function Header(): React.ReactElement {
  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-6">
      <h1 className="text-sm font-medium text-[var(--color-muted)]">Dashboard</h1>
      <ConnectionIndicator />
    </header>
  );
}
