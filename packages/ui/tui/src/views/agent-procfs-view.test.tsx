import { describe, expect, test } from "bun:test";
import { createInitialAgentProcfsView } from "../state/domain-types.js";
import { AgentProcfsView } from "./agent-procfs-view.js";

describe("AgentProcfsView", () => {
  test("is a function component", () => {
    expect(typeof AgentProcfsView).toBe("function");
  });

  test("accepts AgentProcfsViewState props", () => {
    const props = {
      agentProcfsView: createInitialAgentProcfsView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.agentProcfsView.procfs).toBeNull();
    expect(props.agentProcfsView.scrollOffset).toBe(0);
    expect(props.agentProcfsView.loading).toBe(false);
  });

  test("initial state has null procfs", () => {
    const state = createInitialAgentProcfsView();
    expect(state.procfs).toBeNull();
  });
});
