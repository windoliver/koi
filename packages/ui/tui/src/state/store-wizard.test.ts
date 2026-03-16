import { describe, expect, test } from "bun:test";
import { reduce } from "./store.js";
import { createInitialState } from "./types.js";

describe("wizard reducer via store", () => {
  const base = createInitialState("http://localhost:3100/admin/api", "welcome");

  test("set_selected_model updates model", () => {
    const result = reduce(base, { kind: "set_selected_model", model: "openai:gpt-4o" });
    expect(result.selectedModel).toBe("openai:gpt-4o");
  });

  test("set_selected_engine updates engine", () => {
    const result = reduce(base, { kind: "set_selected_engine", engine: "pi" });
    expect(result.selectedEngine).toBe("pi");
  });

  test("set_selected_engine to undefined", () => {
    const withEngine = reduce(base, { kind: "set_selected_engine", engine: "pi" });
    const result = reduce(withEngine, { kind: "set_selected_engine", engine: undefined });
    expect(result.selectedEngine).toBeUndefined();
  });

  test("set_selected_channels updates channels", () => {
    const result = reduce(base, {
      kind: "set_selected_channels",
      channels: ["cli", "slack"],
    });
    expect(result.selectedChannels).toEqual(["cli", "slack"]);
  });

  test("append_phase_progress adds progress", () => {
    const result = reduce(base, {
      kind: "append_phase_progress",
      progress: { phaseId: "test", label: "Test Phase", status: "running" },
    });
    expect(result.phaseProgress).toHaveLength(1);
    expect(result.phaseProgress[0]?.phaseId).toBe("test");
  });

  test("set_setup_running updates flag", () => {
    const result = reduce(base, { kind: "set_setup_running", running: true });
    expect(result.setupRunning).toBe(true);
  });

  test("clear_phase_progress resets progress and running", () => {
    let state = reduce(base, {
      kind: "append_phase_progress",
      progress: { phaseId: "a", label: "A", status: "done" },
    });
    state = reduce(state, { kind: "set_setup_running", running: true });
    state = reduce(state, { kind: "clear_phase_progress" });
    expect(state.phaseProgress).toEqual([]);
    expect(state.setupRunning).toBe(false);
  });

  test("set_model_focused_index updates index", () => {
    const result = reduce(base, { kind: "set_model_focused_index", index: 3 });
    expect(result.modelFocusedIndex).toBe(3);
  });

  test("set_model_focused_index clamps to zero", () => {
    const result = reduce(base, { kind: "set_model_focused_index", index: -1 });
    expect(result.modelFocusedIndex).toBe(0);
  });

  test("set_channel_focused_index updates index", () => {
    const result = reduce(base, { kind: "set_channel_focused_index", index: 2 });
    expect(result.channelFocusedIndex).toBe(2);
  });

  test("set_channel_focused_index clamps to zero", () => {
    const result = reduce(base, { kind: "set_channel_focused_index", index: -5 });
    expect(result.channelFocusedIndex).toBe(0);
  });

  test("toggle_channel adds a channel", () => {
    const result = reduce(base, { kind: "toggle_channel", channel: "slack" });
    expect(result.selectedChannels).toContain("cli");
    expect(result.selectedChannels).toContain("slack");
  });

  test("toggle_channel removes a channel when already selected", () => {
    const withTwo = reduce(base, { kind: "toggle_channel", channel: "slack" });
    const result = reduce(withTwo, { kind: "toggle_channel", channel: "cli" });
    expect(result.selectedChannels).toEqual(["slack"]);
  });

  test("toggle_channel does not remove the last channel", () => {
    // base has only ["cli"]
    const result = reduce(base, { kind: "toggle_channel", channel: "cli" });
    // Should not change — at least one channel must remain
    expect(result.selectedChannels).toEqual(["cli"]);
  });
});
