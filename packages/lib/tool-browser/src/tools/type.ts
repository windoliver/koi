/**
 * Tool factory for `browser_type` — types text into an element by its snapshot ref.
 */

import type { BrowserDriver, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalBoolean, parseString } from "../parse-args.js";
import { createRefActionTool, MAX_TIMEOUT_MS } from "../ref-action.js";

export function createBrowserTypeTool(
  driver: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return createRefActionTool({
    name: `${prefix}_type`,
    description:
      "Type text into an element identified by its snapshot ref. " +
      "Always pass snapshotId from the last browser_snapshot call — " +
      "a STALE_REF error means the ref is outdated and you must re-snapshot. " +
      "Typing may trigger DOM changes (e.g., autocomplete): re-snapshot if needed.",
    extraInputSchema: {
      value: { type: "string", description: "Text to type into the element" },
      clear: {
        type: "boolean",
        description: "Clear existing content before typing (default: false)",
      },
      timeout: {
        type: "number",
        description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
      },
    },
    extraRequired: ["value"],
    extraArgParsers: (args) => {
      const valueResult = parseString(args, "value");
      if (!valueResult.ok) return valueResult;
      const clearResult = parseOptionalBoolean(args, "clear");
      if (!clearResult.ok) return clearResult;
      return {
        ok: true,
        value: {
          ...(clearResult.value !== undefined && { clear: clearResult.value }),
          _value: valueResult.value,
        },
      };
    },
    driver,
    policy,
    execute: async (d, ref, snapshotId, timeout, extraArgs) =>
      d.type(ref, extraArgs._value as string, {
        ...(extraArgs.clear !== undefined && { clear: extraArgs.clear as boolean }),
        ...(snapshotId !== undefined && { snapshotId }),
        ...(timeout !== undefined && { timeout }),
      }),
  });
}
