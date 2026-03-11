import { describe, expect, test, beforeEach } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "../../__tests__/setup.js";
import { makeAgentSummary, resetFixtureCounters } from "../../__tests__/fixtures.js";
import { AgentCard } from "./agent-card.js";

/** Wrap component in MemoryRouter for useNavigate(). */
function renderCard(agent: ReturnType<typeof makeAgentSummary>): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AgentCard agent={agent} />
    </MemoryRouter>,
  );
}

describe("AgentCard", () => {
  beforeEach(() => {
    resetFixtureCounters();
  });

  test("renders agent name", () => {
    const agent = makeAgentSummary({ name: "my-agent" });
    renderCard(agent);
    expect(screen.getByText("my-agent")).toBeDefined();
  });

  test("renders agent type", () => {
    const agent = makeAgentSummary({ agentType: "worker" });
    renderCard(agent);
    expect(screen.getByText("worker")).toBeDefined();
  });

  test("renders model when present", () => {
    const agent = makeAgentSummary({ model: "claude-opus-4-6" });
    renderCard(agent);
    expect(screen.getByText("claude-opus-4-6")).toBeDefined();
  });

  test("does not render model row when absent", () => {
    const agent = makeAgentSummary({ model: undefined });
    const { container } = renderCard(agent);
    const spans = container.querySelectorAll("span");
    const modelLabel = Array.from(spans).find((el) => el.textContent === "Model");
    expect(modelLabel).toBeUndefined();
  });

  test("renders channel list", () => {
    const agent = makeAgentSummary({ channels: ["cli", "telegram"] });
    renderCard(agent);
    expect(screen.getByText("cli, telegram")).toBeDefined();
  });

  test("renders 'none' when no channels", () => {
    const agent = makeAgentSummary({ channels: [] });
    renderCard(agent);
    expect(screen.getByText("none")).toBeDefined();
  });

  test("renders turn count", () => {
    const agent = makeAgentSummary({ turns: 42 });
    renderCard(agent);
    expect(screen.getByText("42")).toBeDefined();
  });

  test("renders state badge", () => {
    const agent = makeAgentSummary({ state: "suspended" });
    renderCard(agent);
    expect(screen.getByText("suspended")).toBeDefined();
  });

  test("renders Open Console button", () => {
    const agent = makeAgentSummary();
    renderCard(agent);
    expect(screen.getByText("Open Console")).toBeDefined();
  });
});
