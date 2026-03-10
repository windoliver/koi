import { describe, expect, test } from "bun:test";
import { render, screen } from "../../__tests__/setup.js";
import { EmptyState } from "./empty-state.js";

describe("EmptyState", () => {
  test("renders title", () => {
    render(<EmptyState title="No agents found" />);
    expect(screen.getByText("No agents found")).toBeDefined();
  });

  test("renders description when provided", () => {
    render(<EmptyState title="Empty" description="Start an agent to see it here" />);
    expect(screen.getByText("Start an agent to see it here")).toBeDefined();
  });

  test("does not render description when absent", () => {
    render(<EmptyState title="Empty" />);
    const desc = screen.queryByText("Start an agent");
    expect(desc).toBeNull();
  });
});
