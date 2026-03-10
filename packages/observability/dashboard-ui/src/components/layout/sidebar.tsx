/**
 * Navigation sidebar with links to dashboard sections.
 */

import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/agents", label: "Agents" },
  { to: "/browser", label: "Browser" },
] as const;

export function Sidebar(): React.ReactElement {
  return (
    <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <div className="mb-6 text-lg font-semibold tracking-tight">Koi</div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
