import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { render } from "../__tests__/setup.js";
import { useForgeStore } from "../stores/forge-store.js";
import { SelfImprovementPage } from "./self-improvement-page.js";

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SelfImprovementPage />
    </MemoryRouter>,
  );
}

describe("SelfImprovementPage", () => {
  beforeEach(() => {
    useForgeStore.setState({
      bricks: {},
      recentEvents: [],
      recentMonitorEvents: [],
      sparklineData: {},
      demandCount: 0,
      crystallizeCount: 0,
    });
  });

  test("renders with empty store without crash", () => {
    const { getByText } = renderPage();
    expect(getByText("Self-Improvement")).toBeDefined();
    expect(getByText("No forge activity yet.")).toBeDefined();
    expect(getByText("No fitness data available.")).toBeDefined();
    expect(getByText("No bricks forged yet.")).toBeDefined();
  });

  test("renders with a forge event", () => {
    useForgeStore.getState().applyBatch([
      {
        kind: "forge",
        subKind: "brick_forged",
        brickId: "b-1",
        name: "my-tool",
        origin: "crystallize",
        ngramKey: "a>b",
        occurrences: 5,
        score: 0.9,
        timestamp: Date.now(),
      },
    ]);
    const { getAllByText } = renderPage();
    // Name shows in both fitness chart and variant results panels
    expect(getAllByText("my-tool").length).toBeGreaterThanOrEqual(1);
  });

  test("renders demand and crystallize counters", () => {
    useForgeStore.getState().applyBatch([
      {
        kind: "forge",
        subKind: "demand_detected",
        signalId: "sig-1",
        triggerKind: "capability_gap",
        confidence: 0.85,
        suggestedBrickKind: "tool",
        timestamp: Date.now(),
      },
    ]);
    const { getByText } = renderPage();
    expect(getByText("Demands: 1")).toBeDefined();
  });
});
