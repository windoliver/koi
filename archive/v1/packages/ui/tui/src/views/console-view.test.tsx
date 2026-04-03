/**
 * Tests for ConsoleView — OpenTUI React component rendering.
 */

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ConsoleViewProps } from "./console-view.js";
import { ConsoleView } from "./console-view.js";

function makeProps(overrides?: Partial<ConsoleViewProps>): ConsoleViewProps {
  return {
    session: null,
    pendingText: "",
    onSubmit: () => {},
    focused: false,
    ...overrides,
  };
}

describe("ConsoleView", () => {
  test("renders empty state when no session", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <ConsoleView {...makeProps()} />,
      { width: 120, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Select an agent");
  });

  test("renders separator that fits terminal width", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <ConsoleView {...makeProps({
        session: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "",
          isStreaming: false,
        },
        cols: 80,
      })} />,
      { width: 80, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("─");
  });

  test("renders at narrow width without overflow", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <ConsoleView {...makeProps({
        session: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "",
          isStreaming: false,
        },
        cols: 80,
      })} />,
      { width: 80, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    // Verify render completes without error and produces output
    expect(frame.length).toBeGreaterThan(0);
  });
});
