import { describe, expect, test } from "bun:test";
import { render } from "../../__tests__/setup.js";
import { EmptyState } from "./empty-state.js";

describe("EmptyState", () => {
  test("renders title", () => {
    const { getByText } = render(<EmptyState title="No agents found" />);
    expect(getByText("No agents found")).toBeDefined();
  });

  test("renders description when provided", () => {
    const { getByText } = render(<EmptyState title="Empty" description="Start an agent to see it here" />);
    expect(getByText("Start an agent to see it here")).toBeDefined();
  });

  test("does not render description when absent", () => {
    const { queryByText } = render(<EmptyState title="Empty" />);
    const desc = queryByText("Start an agent");
    expect(desc).toBeNull();
  });
});
