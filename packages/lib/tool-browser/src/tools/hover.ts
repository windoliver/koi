/**
 * Tool factory for `browser_hover` — hovers over an element by its snapshot ref.
 */

import type { BrowserDriver, Tool, ToolPolicy } from "@koi/core";
import { createRefActionTool } from "../ref-action.js";

export function createBrowserHoverTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return createRefActionTool({
    name: `${prefix}_hover`,
    description:
      "Hover over an element to trigger hover effects such as dropdowns, tooltips, and " +
      "context menus. Always pass snapshotId from the last browser_snapshot call — " +
      "a STALE_REF error means the ref is outdated and you must re-snapshot. " +
      "Call browser_snapshot again after hovering if new elements appear.",
    driver,
    policy,
    execute: async (d, ref, snapshotId, timeout) =>
      d.hover(ref, {
        ...(snapshotId !== undefined && { snapshotId }),
        ...(timeout !== undefined && { timeout }),
      }),
  });
}
