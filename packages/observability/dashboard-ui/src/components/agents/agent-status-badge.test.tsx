import { describe, expect, test } from "bun:test";
import { render, screen } from "../../__tests__/setup.js";
import { AgentStatusBadge } from "./agent-status-badge.js";

describe("AgentStatusBadge", () => {
  test("renders state text", () => {
    render(<AgentStatusBadge state="running" />);
    expect(screen.getByText("running")).toBeDefined();
  });

  test("renders for each known state", () => {
    const states = ["created", "running", "waiting", "suspended", "terminated"] as const;
    for (const state of states) {
      const { unmount } = render(<AgentStatusBadge state={state} />);
      expect(screen.getByText(state)).toBeDefined();
      unmount();
    }
  });

  test("renders unknown state with default style", () => {
    // Cast to test fallback behavior for unexpected states
    render(<AgentStatusBadge state={"unknown" as "running"} />);
    expect(screen.getByText("unknown")).toBeDefined();
  });
});
