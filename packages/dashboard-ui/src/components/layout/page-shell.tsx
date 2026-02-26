/**
 * Shared page layout — sidebar + header + content area.
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
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
