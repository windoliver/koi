/**
 * Top header bar with connection status indicator and theme toggle.
 *
 * Responsive: shows hamburger menu on mobile, sidebar collapse toggle on
 * tablet/desktop.
 */

import { Menu, Moon, Sun, Monitor, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useLayoutStore } from "../../stores/layout-store.js";
import { useThemeStore } from "../../stores/theme-store.js";
import { ConnectionIndicator } from "../shared/connection-indicator.js";

const THEME_ICONS = {
  dark: Moon,
  light: Sun,
  system: Monitor,
} as const;

const THEME_LABELS = {
  dark: "Dark",
  light: "Light",
  system: "System",
} as const;

export function Header(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const Icon = THEME_ICONS[theme];

  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const setMobileOpen = useLayoutStore((s) => s.setMobileOpen);

  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-4 sm:px-6">
      <div className="flex items-center gap-2">
        {/* Mobile hamburger menu */}
        <button
          type="button"
          className="rounded p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)] md:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Sidebar collapse toggle (tablet/desktop) */}
        <button
          type="button"
          className="hidden rounded p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)] md:flex"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>

        <h1 className="text-sm font-medium text-[var(--color-muted)]">Dashboard</h1>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--color-muted)] transition-colors hover:bg-[var(--color-card)] hover:text-[var(--color-foreground)]"
          aria-label={`Theme: ${THEME_LABELS[theme]}. Click to toggle.`}
          title={`Theme: ${THEME_LABELS[theme]} (Ctrl+Shift+T)`}
        >
          <Icon className="h-4 w-4" />
          <span className="hidden sm:inline">{THEME_LABELS[theme]}</span>
        </button>
        <ConnectionIndicator />
      </div>
    </header>
  );
}
