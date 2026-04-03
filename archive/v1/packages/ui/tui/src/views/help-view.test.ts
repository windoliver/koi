/**
 * Tests for the help overlay feature — command registry integration.
 *
 * The keyboard handler tests (? toggle, Esc dismiss) are co-located with
 * tui-keyboard.test.ts. This file tests the data layer: that the command
 * registry provides the correct data for the help view to render.
 */

import { describe, expect, test } from "bun:test";
import { GLOBAL_COMMANDS, getViewCommands, VIEW_COMMAND_MAP } from "../command-registry.js";

describe("help view data", () => {
  test("getViewCommands returns commands for agents view", () => {
    const cmds = getViewCommands("agents");
    expect(cmds.commands.length).toBeGreaterThan(0);
    expect(cmds.footerHint.length).toBeGreaterThan(0);
  });

  test("agents view has dispatch and suspend shortcuts", () => {
    const cmds = getViewCommands("agents");
    const ids = cmds.commands.map((c) => c.id);
    expect(ids).toContain("dispatch");
    expect(ids).toContain("suspend");
  });

  test("GLOBAL_COMMANDS contains Ctrl shortcuts", () => {
    const ctrlCommands = GLOBAL_COMMANDS.filter((cmd) => cmd.ctrlShortcut !== undefined);
    expect(ctrlCommands.length).toBeGreaterThan(0);
    // Verify Ctrl+P is present
    const paletteCmd = ctrlCommands.find((cmd) => cmd.id === "palette");
    expect(paletteCmd).toBeDefined();
    expect(paletteCmd?.ctrlShortcut).toBe("Ctrl+P");
  });

  test("help view is included in the command map", () => {
    const cmds = VIEW_COMMAND_MAP.help;
    expect(cmds).toBeDefined();
    expect(cmds.commands).toEqual([]);
  });

  test("governance view has approve and deny shortcuts", () => {
    const cmds = getViewCommands("governance");
    const shortcuts = cmds.commands.flatMap((c) => (c.shortcut !== undefined ? [c.shortcut] : []));
    expect(shortcuts).toContain("a");
    expect(shortcuts).toContain("d");
  });

  test("every view in the map has a footerHint string", () => {
    for (const [, cmds] of Object.entries(VIEW_COMMAND_MAP)) {
      expect(typeof cmds.footerHint).toBe("string");
    }
  });
});
