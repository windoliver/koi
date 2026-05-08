import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardApp } from "../app.js";
import { EmptyState } from "../components/empty-state.js";
import { ErrorState } from "../components/error-state.js";
import { LoadingState } from "../components/loading-state.js";
import { MetricsPanel } from "../components/metrics-panel.js";
import { SessionDetail } from "../components/session-detail.js";
import { TraceViewer } from "../components/trace-viewer.js";
import { demoDashboardData } from "../lib/demo-data.js";
import { formatDuration, formatRelativeMinutes, formatTimestamp } from "../lib/format.js";
import { createDashboardViewModel } from "../lib/state.js";

describe("DashboardApp", () => {
  test("renders the demo-driven MVP shell", () => {
    const markup = renderToStaticMarkup(<DashboardApp />);

    expect(markup).toContain("Koi Dashboard");
    expect(markup).toContain("Agents");
    expect(markup).toContain("Session detail");
    expect(markup).toContain("Trace");
    expect(markup).toContain("Automation guardrail review");
    expect(markup).toContain("Token usage");
  });

  test("renders local empty, error, and loading states", () => {
    const markup = renderToStaticMarkup(
      <>
        <LoadingState label="Hydrating demo data..." />
        <ErrorState message="Demo fleet failed to load." />
        <EmptyState title="Nothing selected" message="Choose an agent from the fleet." />
      </>,
    );

    expect(markup).toContain("Hydrating demo data...");
    expect(markup).toContain("Demo fleet failed to load.");
    expect(markup).toContain("Nothing selected");
  });

  test("renders fallback views for empty metrics, empty trace, and missing session", () => {
    const markup = renderToStaticMarkup(
      <>
        <SessionDetail selectedSession={null} visibleSessions={[]} onSelectSession={() => {}} />
        <MetricsPanel metrics={[]} />
        <TraceViewer trace={[]} />
      </>,
    );

    expect(markup).toContain("No session selected");
    expect(markup).toContain("No metrics collected");
    expect(markup).toContain("No trace events yet");
  });

  test("formats timestamps and durations for the session detail surfaces", () => {
    expect(formatTimestamp("2026-05-07T22:14:40.000Z")).toContain("May");
    expect(formatRelativeMinutes("2026-05-07T22:10:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "4m ago",
    );
    expect(formatRelativeMinutes("2026-05-07T20:14:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "2h ago",
    );
    expect(formatRelativeMinutes("2026-05-07T20:09:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "2h 5m ago",
    );
    expect(formatDuration(30 * 60_000)).toBe("30m");
    expect(formatDuration(2 * 60 * 60_000)).toBe("2h");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
  });

  test("renders alternate agent sessions from the derived local view model", () => {
    const state = createDashboardViewModel(demoDashboardData);
    const markup = renderToStaticMarkup(
      <SessionDetail
        selectedSession={state.selectedSession}
        visibleSessions={state.visibleSessions}
        onSelectSession={() => {}}
      />,
    );

    expect(markup).toContain("Dashboard shell smoke pass");
    expect(markup).toContain("Automation guardrail review");
  });
});
