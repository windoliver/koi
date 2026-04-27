/**
 * Clipboard utilities tests.
 *
 * OSC 52 text copy (copyToClipboard) was removed in #1940 — TUI components
 * now call renderer.copyToClipboardOSC52() directly so the sequence flows
 * through the renderer's output path instead of bypassing it via direct
 * process.stdout.write. See: packages/ui/tui/src/utils/clipboard.ts.
 */

import { describe, expect, test } from "bun:test";
import { readClipboardImage } from "./clipboard.js";

describe("readClipboardImage", () => {
  test("returns null on unsupported platform when tool is missing", async () => {
    // readClipboardImage always catches errors and returns null, so it is safe
    // to call in a test environment without the platform tools present.
    const result = await readClipboardImage();
    // Test environments have no clipboard tools, so null is the expected result.
    expect(result).toBeNull();
  });
});
