import type { ReactElement } from "react";
import type { DashboardMetric } from "../lib/state.js";
import { EmptyState } from "./empty-state.js";

export function MetricsPanel({ metrics }: { metrics: DashboardMetric[] }): ReactElement {
  return (
    <section className="dashboard-panel" aria-label="Metrics">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Health</p>
          <h2>Metrics</h2>
        </div>
      </div>

      {metrics.length === 0 ? (
        <EmptyState
          title="No metrics collected"
          message="The selected session has not produced any local demo metrics yet."
        />
      ) : (
        <div className="metric-grid">
          {metrics.map((metric) => (
            <article key={metric.label} className={`metric-card metric-card--${metric.trend}`}>
              <p className="metric-card__label">{metric.label}</p>
              <strong>{metric.value}</strong>
              <p className="metric-card__detail">{metric.detail}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
