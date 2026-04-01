/**
 * ActiveToolCallIndicator tests.
 */

import { describe, expect, test } from "bun:test";
import { render } from "../../__tests__/setup.js";
import { ActiveToolCallIndicator } from "./active-tool-call.js";

describe("ActiveToolCallIndicator", () => {
  test("renders nothing when no active tool calls", () => {
    const { container } = render(<ActiveToolCallIndicator toolCalls={{}} />);
    expect(container.innerHTML).toBe("");
  });

  test("renders active tool call with name and running status", () => {
    const { getByText } = render(
      <ActiveToolCallIndicator
        toolCalls={{ tc1: { name: "search", args: "" } }}
      />,
    );
    expect(getByText("search")).toBeDefined();
    expect(getByText("running...")).toBeDefined();
  });

  test("renders accumulated args when present", () => {
    const { getByText } = render(
      <ActiveToolCallIndicator
        toolCalls={{ tc1: { name: "lookup", args: '{"q":"test"}' } }}
      />,
    );
    expect(getByText("lookup")).toBeDefined();
    // Pretty-printed JSON
    expect(getByText(/"q": "test"/)).toBeDefined();
  });

  test("renders multiple active tool calls", () => {
    const { getByText } = render(
      <ActiveToolCallIndicator
        toolCalls={{
          tc1: { name: "search", args: "" },
          tc2: { name: "read_file", args: '{"path":"/foo"}' },
        }}
      />,
    );
    expect(getByText("search")).toBeDefined();
    expect(getByText("read_file")).toBeDefined();
  });

  test("truncates very long partial args", () => {
    const longArgs = "x".repeat(300);
    const { container } = render(
      <ActiveToolCallIndicator
        toolCalls={{ tc1: { name: "tool", args: longArgs } }}
      />,
    );
    const pre = container.querySelector("pre");
    expect(pre).toBeDefined();
    // Should be truncated to 200 chars + ellipsis
    expect(pre?.textContent?.endsWith("...")).toBe(true);
    expect(pre?.textContent?.length).toBeLessThan(300);
  });
});
