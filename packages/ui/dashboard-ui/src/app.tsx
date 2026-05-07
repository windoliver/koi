import type { ReactElement } from "react";

export function DashboardApp(): ReactElement {
  return (
    <main className="dashboard-shell">
      <section className="dashboard-card" aria-label="Dashboard shell">
        <p className="dashboard-eyebrow">Dashboard UI</p>
        <h1>Koi Dashboard</h1>
        <p className="dashboard-copy">A minimal shell for upcoming dashboard features.</p>
      </section>
    </main>
  );
}
