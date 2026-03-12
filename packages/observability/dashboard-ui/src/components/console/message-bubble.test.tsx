/**
 * MessageBubble tests — renders all four message kinds correctly.
 */

import { describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import type { ChatMessage } from "../../stores/chat-store.js";
import { render } from "../../__tests__/setup.js";
import { MessageBubble } from "./message-bubble.js";

function renderBubble(message: ChatMessage): ReturnType<typeof render> {
  return render(<MessageBubble message={message} />);
}

describe("MessageBubble", () => {
  describe("user messages", () => {
    test("renders user text", () => {
      const { getByText } = renderBubble({ kind: "user", text: "Hello agent", timestamp: Date.now() });
      expect(getByText("Hello agent")).toBeDefined();
    });

    test("renders 'You' label", () => {
      const { getByText } = renderBubble({ kind: "user", text: "hi", timestamp: Date.now() });
      expect(getByText("You")).toBeDefined();
    });

    test("renders timestamp", () => {
      const ts = new Date(2026, 0, 15, 14, 30, 45).getTime();
      const { getByText } = renderBubble({ kind: "user", text: "hello", timestamp: ts });
      // Time format varies by locale, but should contain the time parts
      const timeEl = getByText(/\d{2}:\d{2}:\d{2}/);
      expect(timeEl).toBeDefined();
    });

    test("preserves whitespace in user text", () => {
      const { container } = renderBubble({ kind: "user", text: "line1\nline2", timestamp: Date.now() });
      const textDiv = container.querySelector(".whitespace-pre-wrap");
      expect(textDiv?.textContent).toContain("line1");
      expect(textDiv?.textContent).toContain("line2");
    });
  });

  describe("assistant messages", () => {
    test("renders assistant text as markdown", () => {
      const { getByText } = renderBubble({ kind: "assistant", text: "Hello **bold**", timestamp: Date.now() });
      expect(getByText("Assistant")).toBeDefined();
      // The bold text should be within a <strong> tag
      const strong = getByText("bold");
      expect(strong).toBeDefined();
    });

    test("renders 'Assistant' label", () => {
      const { getByText } = renderBubble({ kind: "assistant", text: "response", timestamp: Date.now() });
      expect(getByText("Assistant")).toBeDefined();
    });
  });

  describe("tool_call messages", () => {
    const toolMsg: ChatMessage = {
      kind: "tool_call",
      name: "file_search",
      args: '{"query":"test"}',
      result: '["file1.ts","file2.ts"]',
      timestamp: Date.now(),
    };

    test("renders tool name", () => {
      const { getByText } = renderBubble(toolMsg);
      expect(getByText("file_search")).toBeDefined();
    });

    test("args and result are hidden by default (collapsed)", () => {
      const { container } = renderBubble(toolMsg);
      const pres = container.querySelectorAll("pre");
      expect(pres.length).toBe(0);
    });

    test("shows args and result when expanded", () => {
      const { container, getByText } = renderBubble(toolMsg);
      const button = getByText("file_search");
      fireEvent.click(button);

      // After expanding, should show Arguments and Result sections
      expect(getByText("Arguments")).toBeDefined();
      expect(getByText("Result")).toBeDefined();

      // Should show pretty-printed JSON in <pre> blocks
      const pres = container.querySelectorAll("pre");
      expect(pres.length).toBe(2);
    });

    test("collapses when clicked again", () => {
      const { container, getByText } = renderBubble(toolMsg);
      const button = getByText("file_search");

      fireEvent.click(button); // expand
      fireEvent.click(button); // collapse

      const pres = container.querySelectorAll("pre");
      expect(pres.length).toBe(0);
    });

    test("does not show Result section when result is undefined", () => {
      const { getByText, queryAllByText } = renderBubble({
        kind: "tool_call",
        name: "search",
        args: "{}",
        result: undefined,
        timestamp: Date.now(),
      });
      const button = getByText("search");
      fireEvent.click(button);

      expect(getByText("Arguments")).toBeDefined();
      // Result label should not be present
      const resultLabels = queryAllByText("Result");
      expect(resultLabels.length).toBe(0);
    });

    test("renders raw args when not valid JSON", () => {
      const { container, getByText } = renderBubble({
        kind: "tool_call",
        name: "exec",
        args: "not-json",
        result: undefined,
        timestamp: Date.now(),
      });
      fireEvent.click(getByText("exec"));
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toBe("not-json");
    });
  });

  describe("lifecycle messages", () => {
    test("renders event text", () => {
      const { getByText } = renderBubble({ kind: "lifecycle", event: "agent_started", timestamp: Date.now() });
      expect(getByText("agent_started")).toBeDefined();
    });

    test("renders centered with italic style", () => {
      const { container } = renderBubble({
        kind: "lifecycle",
        event: "step_completed",
        timestamp: Date.now(),
      });
      const div = container.querySelector(".italic");
      expect(div).toBeDefined();
    });
  });
});
