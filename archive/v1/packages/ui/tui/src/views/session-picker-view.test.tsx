/**
 * Tests for SessionPickerView — displays saved sessions for selection.
 */

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { SessionPickerEntry } from "../state/types.js";
import { SessionPickerView } from "./session-picker-view.js";

function makeSession(overrides: Partial<SessionPickerEntry> = {}): SessionPickerEntry {
  return {
    sessionId: "s1",
    agentId: "agent-001",
    agentName: "test-agent",
    connectedAt: Date.now() - 120_000,
    messageCount: 15,
    preview: "",
    ...overrides,
  };
}

/** Render multiple passes so the select component populates its items. */
async function settle(renderOnce: () => Promise<void>): Promise<void> {
  await renderOnce();
  await renderOnce();
}

describe("SessionPickerView", () => {
  test("renders header with session count", async () => {
    const sessions = [makeSession(), makeSession({ sessionId: "s2", agentName: "other" })];
    const { captureCharFrame, renderOnce } = await testRender(
      <SessionPickerView
        sessions={sessions}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
        loading={false}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("Sessions");
    expect(frame).toContain("(2)");
  });

  test("shows empty state when no sessions", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <SessionPickerView
        sessions={[]}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
        loading={false}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("No saved sessions");
  });

  test("shows loading state", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <SessionPickerView
        sessions={[]}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
        loading={true}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("Loading");
  });

  test("displays session entries with agent names", async () => {
    const sessions = [
      makeSession({ agentName: "alpha-agent" }),
      makeSession({ sessionId: "s2", agentName: "beta-agent" }),
    ];
    const { captureCharFrame, renderOnce } = await testRender(
      <SessionPickerView
        sessions={sessions}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
        loading={false}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("alpha-agent");
    expect(frame).toContain("beta-agent");
  });

  test("shows message count in description", async () => {
    const sessions = [makeSession({ messageCount: 42 })];
    const { captureCharFrame, renderOnce } = await testRender(
      <SessionPickerView
        sessions={sessions}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
        loading={false}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("42 msgs");
  });

  test("calls onSelect when session is selected", async () => {
    const sessions = [makeSession({ sessionId: "pick-me" })];
    let selectedId = "";
    const { mockInput, renderOnce } = await testRender(
      <SessionPickerView
        sessions={sessions}
        onSelect={(id) => { selectedId = id; }}
        onCancel={() => {}}
        focused={true}
        loading={false}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    mockInput.pressEnter();
    await renderOnce();
    expect(selectedId).toBe("pick-me");
  });
});
