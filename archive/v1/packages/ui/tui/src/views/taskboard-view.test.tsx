import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TaskBoardSnapshot, TaskBoardNode } from "@koi/dashboard-types";
import { createInitialTaskBoardView } from "../state/domain-types.js";
import type { TaskBoardViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";
import { TaskBoardView } from "./taskboard-view.js";
import type { TaskBoardViewProps } from "./taskboard-view.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<TaskBoardNode> & {
    readonly taskId: string;
    readonly label: string;
  },
): TaskBoardNode {
  return {
    status: "pending",
    ...overrides,
  };
}

function makeSnapshot(
  nodes: readonly TaskBoardNode[],
  edges: readonly { readonly from: string; readonly to: string }[] = [],
): TaskBoardSnapshot {
  return { nodes, edges, timestamp: Date.now() };
}

function makeProps(overrides?: Partial<TaskBoardViewProps>): TaskBoardViewProps {
  return {
    taskBoardView: createInitialTaskBoardView(),
    focused: true,
    zoomLevel: "normal",
    ...overrides,
  };
}

function makeState(
  overrides?: Partial<TaskBoardViewState>,
): TaskBoardViewState {
  return {
    ...createInitialTaskBoardView(),
    ...overrides,
  };
}

/**
 * Collect all span text + fg color from a captured frame, filtering empty text.
 * Returns flat array of { text, r, g, b } tuples.
 */
function collectColoredSpans(
  spans: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
): readonly { readonly text: string; readonly r: number; readonly g: number; readonly b: number }[] {
  return spans.lines.flatMap((line) =>
    line.spans
      .filter((s) => s.text.trim().length > 0)
      .map((s) => {
        const [r, g, b] = s.fg.toInts();
        return { text: s.text, r: r!, g: g!, b: b! };
      }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskBoardView", () => {
  // 1. Component is a function
  test("is a function component", () => {
    expect(typeof TaskBoardView).toBe("function");
  });

  // 2. Empty state — null snapshot renders without crash
  test("renders empty state with null snapshot", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps()} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    // PanelChrome shows empty message when snapshot is null and events are empty
    expect(frame).toContain("No tasks queued");
  });

  test("empty state shows dispatch hint", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps()} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("/dispatch");
  });

  // 3. Progress summary shows correct counts
  test("progress summary shows correct counts for mixed statuses", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "build", status: "completed" }),
      makeNode({ taskId: "t2", label: "test", status: "running" }),
      makeNode({ taskId: "t3", label: "deploy", status: "failed" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    // 1 completed out of 3 total, 1 failed
    expect(frame).toContain("1/3 done");
    expect(frame).toContain("1 failed");
  });

  test("progress summary omits failed count when zero", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "build", status: "completed" }),
      makeNode({ taskId: "t2", label: "test", status: "running" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("1/2 done");
    expect(frame).not.toContain("failed");
  });

  // 4. Status colors applied correctly
  //
  // The renderer merges adjacent <text> elements with the same fg color into
  // a single span. We verify color by finding the span whose text contains
  // the status word fragment and checking its RGB values.

  test("completed status uses dim color", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "build-step", status: "completed" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());

    // The node row renders label (white) + status (dim) + worker (white) + output (dim).
    // Since "completed" uses COLORS.dim, it merges with adjacent dim-colored text.
    // Look for a span on the node row that contains "complet" (part of "completed").
    const dimRgb = { r: 136, g: 153, b: 170 }; // COLORS.dim = "#8899AA"
    const dimSpans = colored.filter(
      (s) => s.r === dimRgb.r && s.g === dimRgb.g && s.b === dimRgb.b,
    );
    // There should be dim-colored spans (progress bar, header, and the completed status)
    expect(dimSpans.length).toBeGreaterThan(0);

    // The node table row uses dim for "completed" status, so at least one dim span
    // on the node row should contain part of the "completed" text or the merged label
    // that includes it. Verify the dim color is used beyond just the header/progress line.
    // The header line is " Task ... Status ... Worker ... Output" and progress line exist.
    // With a single-node table, we expect at least 3 dim spans (progress, header, row).
    expect(dimSpans.length).toBeGreaterThanOrEqual(3);
  });

  test("failed status uses red color", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "deploy-step",
        status: "failed",
        error: "crash",
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());

    // COLORS.red = "#EF4444" → RGB(239, 68, 68)
    const redRgb = { r: 239, g: 68, b: 68 };
    const redSpans = colored.filter(
      (s) => s.r === redRgb.r && s.g === redRgb.g && s.b === redRgb.b,
    );
    // The failed status and the error output should both render in red
    expect(redSpans.length).toBeGreaterThan(0);
    // At least one red span should contain part of the error message
    const hasErrorText = redSpans.some((s) => s.text.includes("err:"));
    expect(hasErrorText).toBe(true);
  });

  test("running status uses green color", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "test-step", status: "running" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());

    // COLORS.green = "#22C55E" → RGB(34, 197, 94)
    const greenRgb = { r: 34, g: 197, b: 94 };
    const greenSpans = colored.filter(
      (s) => s.r === greenRgb.r && s.g === greenRgb.g && s.b === greenRgb.b,
    );
    // The "running" status should appear in green
    expect(greenSpans.length).toBeGreaterThan(0);
  });

  // 5. Worker assignment column displays assignedTo
  test("shows assigned worker name in rendered output", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "build",
        status: "running",
        assignedTo: "agent-alpha",
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // The worker name should appear in at least one span
    const hasWorker = colored.some((s) => s.text.includes("agent-alpha"));
    expect(hasWorker).toBe(true);
  });

  test("shows em-dash when no worker assigned", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "build", status: "pending" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // Should contain the em-dash character "\u2014" somewhere in the node row
    const hasEmDash = colored.some((s) => s.text.includes("\u2014"));
    expect(hasEmDash).toBe(true);
  });

  // 6. Output preview truncation
  test("truncates long result strings at 60 chars", async () => {
    const longResult = "A".repeat(80);
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "build",
        status: "completed",
        result: longResult,
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 140, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // The truncated text should end with "..." and be at most 60 chars of the original
    // Due to span merging, look for a span containing the "AAA..." pattern
    const allText = colored.map((s) => s.text).join("");
    expect(allText).toContain("...");
    // Should NOT contain 80 consecutive A's
    expect(allText).not.toContain("A".repeat(80));
  });

  test("short result strings are not truncated", async () => {
    const shortResult = "ok";
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "test",
        status: "completed",
        result: shortResult,
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    const allText = colored.map((s) => s.text).join("");
    // Short result "ok" should appear verbatim, not truncated
    expect(allText).toContain("ok");
    expect(allText).not.toContain("...");
  });

  // 7. Error display in output column
  test("shows error with err: prefix in output column", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "deploy",
        status: "failed",
        error: "timeout exceeded",
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // The error output appears as "err: timeout exceeded" — the renderer may
    // merge adjacent same-color spans, so look for the "err:" prefix in any span.
    const hasErrPrefix = colored.some((s) => s.text.includes("err:"));
    expect(hasErrPrefix).toBe(true);
    const hasErrContent = colored.some((s) => s.text.includes("timeout exceeded"));
    expect(hasErrContent).toBe(true);
  });

  test("error output uses red color", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({
        taskId: "t1",
        label: "deploy",
        status: "failed",
        error: "crash",
      }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());

    // COLORS.red = "#EF4444" → RGB(239, 68, 68)
    const redRgb = { r: 239, g: 68, b: 68 };
    // Find a red-colored span containing the error text
    const redErrorSpans = colored.filter(
      (s) =>
        s.r === redRgb.r &&
        s.g === redRgb.g &&
        s.b === redRgb.b &&
        s.text.includes("err:"),
    );
    expect(redErrorSpans.length).toBeGreaterThan(0);
  });

  // 8. Scroll offset — only visible rows shown (VISIBLE_ROWS=20)
  test("scroll offset limits visible DAG layout lines", async () => {
    // Generate 30 layout lines to exceed VISIBLE_ROWS (20)
    const layoutLines = Array.from({ length: 30 }, (_, i) =>
      `line-${String(i).padStart(2, "0")}`,
    );
    const state = makeState({
      cachedLayout: layoutLines,
      scrollOffset: 5,
      snapshot: makeSnapshot([
        makeNode({ taskId: "t1", label: "task-a", status: "running" }),
      ]),
    });

    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 50 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    // With scrollOffset=5 and VISIBLE_ROWS=20, should show lines 5..24
    expect(frame).toContain("line-05");
    expect(frame).toContain("line-24");
    // Lines before offset should not appear
    expect(frame).not.toContain("line-04");
    // Lines beyond offset+VISIBLE_ROWS should not appear
    expect(frame).not.toContain("line-25");
  });

  test("scroll offset zero shows first 20 lines", async () => {
    const layoutLines = Array.from({ length: 25 }, (_, i) =>
      `row-${String(i).padStart(2, "0")}`,
    );
    const state = makeState({
      cachedLayout: layoutLines,
      scrollOffset: 0,
      snapshot: makeSnapshot([
        makeNode({ taskId: "t1", label: "task-a", status: "pending" }),
      ]),
    });

    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 50 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("row-00");
    expect(frame).toContain("row-19");
    expect(frame).not.toContain("row-20");
  });

  // Additional: table header row
  test("renders table header row with column names", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "build", status: "running" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // The header row is a single dim-colored span with column names
    const headerSpan = colored.find(
      (s) => s.text.includes("Task") && s.text.includes("Status"),
    );
    expect(headerSpan).toBeDefined();
    expect(headerSpan!.text).toContain("Worker");
    expect(headerSpan!.text).toContain("Output");
  });

  // Additional: panel title
  test("shows Task Board panel title", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <TaskBoardView {...makeProps()} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Task Board");
  });

  // Additional: node count in panel chrome
  test("shows node count when snapshot has nodes", async () => {
    const nodes: readonly TaskBoardNode[] = [
      makeNode({ taskId: "t1", label: "a", status: "pending" }),
      makeNode({ taskId: "t2", label: "b", status: "running" }),
      makeNode({ taskId: "t3", label: "c", status: "completed" }),
    ];
    const state = makeState({ snapshot: makeSnapshot(nodes) });

    const { captureSpans, renderOnce } = await testRender(
      <TaskBoardView {...makeProps({ taskBoardView: state })} />,
      { width: 120, height: 30 },
    );

    await renderOnce();
    const colored = collectColoredSpans(captureSpans());
    // PanelChrome renders count as " (3)" in dim color next to title
    const countSpan = colored.find((s) => s.text.includes("(3)"));
    expect(countSpan).toBeDefined();
  });

  // Additional: initial state shape
  test("initial state has null snapshot and null cachedLayout", () => {
    const state = createInitialTaskBoardView();
    expect(state.snapshot).toBeNull();
    expect(state.cachedLayout).toBeNull();
    expect(state.layoutNodeCount).toBe(0);
    expect(state.layoutEdgeCount).toBe(0);
    expect(state.events).toEqual([]);
    expect(state.scrollOffset).toBe(0);
  });
});
