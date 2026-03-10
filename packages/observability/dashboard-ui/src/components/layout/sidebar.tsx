/**
 * Navigation sidebar with links to dashboard sections.
 *
 * Responsive modes:
 * - Desktop (>=1024px): full sidebar with labels, 224px wide
 * - Tablet (768-1023px): collapsed to icons only, 48px wide
 * - Mobile (<768px): hidden by default, slide-out overlay via hamburger
 */

import { NavLink } from "react-router-dom";
import { Bot, FolderTree, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLayoutStore } from "../../stores/layout-store.js";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/browser", label: "Browser", icon: FolderTree },
] as const;

export function Sidebar(): React.ReactElement {
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const sidebarMobileOpen = useLayoutStore((s) => s.sidebarMobileOpen);
  const setMobileOpen = useLayoutStore((s) => s.setMobileOpen);

  return (
    <>
      {/* Desktop / tablet sidebar */}
      <aside
        className={`hidden md:flex shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-card)] p-4 transition-[width] duration-200 ${
          sidebarCollapsed ? "w-14 items-center" : "w-56"
        }`}
      >
        <SidebarContent collapsed={sidebarCollapsed} />
      </aside>

      {/* Mobile overlay sidebar */}
      {sidebarMobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {/* Backdrop */}
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-label="Close sidebar"
          />
          {/* Panel */}
          <aside className="relative z-10 flex w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-card)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-lg font-semibold tracking-tight">Koi</span>
              <button
                type="button"
                className="rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                onClick={() => setMobileOpen(false)}
                aria-label="Close sidebar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}

function SidebarContent({
  collapsed,
}: {
  readonly collapsed: boolean;
}): React.ReactElement {
  return (
    <>
      {!collapsed && (
        <div className="mb-6 text-lg font-semibold tracking-tight">Koi</div>
      )}
      {collapsed && (
        <div className="mb-6 text-lg font-semibold tracking-tight">K</div>
      )}
      <SidebarNav collapsed={collapsed} />
    </>
  );
}

function SidebarNav({
  collapsed,
  onNavigate,
}: {
  readonly collapsed: boolean;
  readonly onNavigate?: () => void;
}): React.ReactElement {
  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          title={collapsed ? item.label : undefined}
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              collapsed ? "justify-center" : ""
            } ${
              isActive
                ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            }`
          }
        >
          <item.icon className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{item.label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
