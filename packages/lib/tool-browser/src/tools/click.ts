/**
 * Tool factory for `browser_click` — clicks an element by its snapshot ref.
 */

import type { BrowserDriver, Tool, ToolPolicy } from "@koi/core";
import { createRefActionTool } from "../ref-action.js";

export function createBrowserClickTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return createRefActionTool({
    name: `${prefix}_click`,
    description:
      "Click an element identified by its snapshot ref. " +
      "Always pass snapshotId from the last browser_snapshot call — if the ref " +
      "is stale you receive STALE_REF, meaning you must call browser_snapshot " +
      "again before retrying. Clicking may change the DOM: re-snapshot if you " +
      "need to interact with elements that appear or move after the click.",
    driver,
    policy,
    execute: async (d, ref, snapshotId, timeout) =>
      d.click(ref, {
        ...(snapshotId !== undefined && { snapshotId }),
        ...(timeout !== undefined && { timeout }),
      }),
  });
}
