/**
 * Self-improvement page — forge observability dashboard.
 *
 * Shows brick lifecycle timeline, fitness sparklines,
 * demand signal feed, and variant optimization results.
 */

import { BrickTimelinePanel } from "../components/forge/brick-timeline-panel.js";
import { DemandFeedPanel } from "../components/forge/demand-feed-panel.js";
import { FitnessChartPanel } from "../components/forge/fitness-chart-panel.js";
import { VariantResultsPanel } from "../components/forge/variant-results-panel.js";
import { ErrorBoundary } from "../components/shared/error-boundary.js";

export function SelfImprovementPage(): React.ReactElement {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold">Self-Improvement</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ErrorBoundary>
          <BrickTimelinePanel />
        </ErrorBoundary>
        <ErrorBoundary>
          <FitnessChartPanel />
        </ErrorBoundary>
        <ErrorBoundary>
          <DemandFeedPanel />
        </ErrorBoundary>
        <ErrorBoundary>
          <VariantResultsPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}
