/**
 * Shared page layout — sidebar + header + content area.
 *
 * Responsive:
 * - Desktop (>=1024px): full sidebar + content
 * - Tablet (768-1023px): collapsed sidebar (icons only) + content
 * - Mobile (<768px): no sidebar (hamburger opens overlay), full content
 */

import { Outlet } from "react-router-dom";
import { Header } from "./header.js";
import { Sidebar } from "./sidebar.js";

export function PageShell(): React.ReactElement {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-3 sm:p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
