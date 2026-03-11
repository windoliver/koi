/**
 * Tests for CommandPaletteView — overlay with fuzzy-search filtering.
 */

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { CommandPaletteView } from "./command-palette-view.js";

/** Render multiple passes so the select component populates its items. */
async function settle(renderOnce: () => Promise<void>): Promise<void> {
  await renderOnce();
  await renderOnce();
}

describe("CommandPaletteView", () => {
  test("renders command header when visible", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <CommandPaletteView
        visible={true}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
      />,
      { width: 80, height: 30 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("Commands");
  });

  test("renders nothing when not visible", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <CommandPaletteView
        visible={false}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={false}
      />,
      { width: 80, height: 30 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).not.toContain("Commands");
  });

  test("shows default commands in select list", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <CommandPaletteView
        visible={true}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
      />,
      { width: 80, height: 30 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    // Should show at least one of the default commands
    expect(frame).toContain("Refresh");
  });

  test("shows filter input placeholder", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <CommandPaletteView
        visible={true}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
      />,
      { width: 80, height: 30 },
    );

    await settle(renderOnce);
    const frame = captureCharFrame();
    expect(frame).toContain("filter");
  });

  test("shows border and overlay styling", async () => {
    const { captureSpans, renderOnce } = await testRender(
      <CommandPaletteView
        visible={true}
        onSelect={() => {}}
        onCancel={() => {}}
        focused={true}
      />,
      { width: 80, height: 30 },
    );

    await settle(renderOnce);
    const spans = captureSpans();
    // Should have rendered content on multiple lines (header + input + commands)
    const nonEmptyLines = spans.lines.filter((line) =>
      line.spans.some((s) => s.text.trim().length > 0),
    );
    expect(nonEmptyLines.length).toBeGreaterThan(2);
  });
});
