import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "../../__tests__/setup.js";
import { AgentStatusBadge } from "./agent-status-badge.js";

describe("AgentStatusBadge", () => {
  beforeEach(() => {
    cleanup();
  });

  test("renders state text", () => {
    const { getByText } = render(<AgentStatusBadge state="running" />);
    expect(getByText("running")).toBeDefined();
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
    const { getByText } = render(<AgentStatusBadge state={"unknown" as "running"} />);
    expect(getByText("unknown")).toBeDefined();
  });
});
