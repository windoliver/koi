import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "../../__tests__/setup.js";
import { AgentStatusBadge } from "./agent-status-badge.js";

describe("AgentStatusBadge", () => {
  beforeEach(() => {
    cleanup();
  });

  test("renders state text", () => {
    render(<AgentStatusBadge state="running" />);
    expect(screen.getByText("running")).toBeDefined();
  });

  test("renders for each known state", () => {
    const states = ["created", "running", "waiting", "suspended", "terminated"] as const;
    for (const state of states) {
      cleanup();
      const { container } = render(<AgentStatusBadge state={state} />);
      const span = container.querySelector("span");
      expect(span?.textContent).toBe(state);
    }
  });

  test("renders unknown state with default style", () => {
    render(<AgentStatusBadge state={"unknown" as "running"} />);
    expect(screen.getByText("unknown")).toBeDefined();
  });
});
