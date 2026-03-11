/**
 * Tests for AgentListView — OpenTUI React component rendering.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { testRender } from "@opentui/react/test-utils";
import { AgentListView } from "./agent-list-view.js";

function makeAgent(overrides: Partial<DashboardAgentSummary> = {}): DashboardAgentSummary {
  return {
    agentId: agentId("a1"),
    name: "test-agent",
    agentType: "worker",
    state: "running",
    model: "gpt-4",
    channels: [],
    turns: 10,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

/** Render multiple passes so the select component populates its items. */
async function settle(renderOnce: () => Promise<void>): Promise<void> {
  await renderOnce();
  await renderOnce();
}

describe("AgentListView", () => {
  test("renders header with agent count", async () => {
    const agents = [makeAgent(), makeAgent({ agentId: agentId("a2"), name: "second" })];
    const { captureCharFrame, renderOnce } = await testRender(
      <AgentListView agents={agents} onSelect={() => {}} focused={true} />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("Agents");
    expect(frame).toContain("(2)");
  });

  test("shows empty state when no agents", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <AgentListView agents={[]} onSelect={() => {}} focused={true} />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("No agents found");
  });

  test("displays agent names in list", async () => {
    const agents = [
      makeAgent({ name: "alpha-agent" }),
      makeAgent({ agentId: agentId("a2"), name: "beta-agent" }),
    ];
    const { captureCharFrame, renderOnce } = await testRender(
      <AgentListView agents={agents} onSelect={() => {}} focused={true} />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("alpha-agent");
    expect(frame).toContain("beta-agent");
  });

  test("shows agent state in description", async () => {
    const agents = [makeAgent({ state: "running", model: "claude-3" })];
    const { captureCharFrame, renderOnce } = await testRender(
      <AgentListView agents={agents} onSelect={() => {}} focused={true} />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("running");
    expect(frame).toContain("claude-3");
  });

  test("calls onSelect when agent is selected", async () => {
    const agents = [makeAgent({ agentId: agentId("select-me") })];
    let selectedId = "";
    const { mockInput, renderOnce } = await testRender(
      <AgentListView
        agents={agents}
        onSelect={(id) => { selectedId = id; }}
        focused={true}
      />,
      { width: 80, height: 20 },
    );

    await settle(renderOnce);
    mockInput.pressEnter();
    await renderOnce();
    expect(selectedId).toBe("select-me");
  });
});
