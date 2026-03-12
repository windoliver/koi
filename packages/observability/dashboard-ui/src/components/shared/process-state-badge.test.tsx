import { describe, expect, test } from "bun:test";
import { cleanup, render } from "../../__tests__/setup.js";
import { ProcessStateBadge } from "./process-state-badge.js";

describe("ProcessStateBadge", () => {
  test("renders each known state with appropriate text", () => {
    const states = [
      "created",
      "running",
      "waiting",
      "suspended",
      "terminated",
      "failed",
      "degraded",
    ] as const;

    for (const state of states) {
      cleanup();
      const { getByText } = render(<ProcessStateBadge state={state} />);
      expect(getByText(state)).toBeDefined();
    }
  });

  test("renders unknown state with default styling", () => {
    const { getByText } = render(<ProcessStateBadge state="rebooting" />);
    expect(getByText("rebooting")).toBeDefined();
  });
});
