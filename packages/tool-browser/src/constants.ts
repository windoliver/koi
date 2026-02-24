/**
 * Constants for @koi/tool-browser — tool names, operations, and SDK mappings.
 */

/** Default tool name prefix for browser tools. */
export const DEFAULT_PREFIX = "browser" as const;

/**
 * System prompt guidance for agents using browser tools.
 *
 * Include this in your agent's system prompt or koi.yaml `instructions` field
 * to prime the agent with the snapshot-act-snapshot pattern and error-handling
 * strategy that minimises hallucinated refs and unnecessary retries.
 *
 * Usage:
 * ```ts
 * import { BROWSER_SYSTEM_PROMPT } from "@koi/tool-browser";
 * // Add to your agent manifest's system prompt:
 * // system: BROWSER_SYSTEM_PROMPT
 * ```
 */
export const BROWSER_SYSTEM_PROMPT: string = `
## Browser automation — snapshot-act-snapshot loop

Always follow this loop when operating the browser:

1. **Snapshot first** — call \`browser_snapshot\` before every action.
   The snapshot returns \`snapshotId\` and a list of interactive elements
   with [ref=eN] markers (e.g., [button] Submit [ref=e3]).

2. **Pass snapshotId to every action** — include the \`snapshotId\` field
   from the latest snapshot in every interaction call (browser_click,
   browser_type, browser_fill_form, etc.). This lets the browser detect
   stale refs immediately instead of acting on wrong elements.

3. **Re-snapshot after DOM changes** — after clicking a button, submitting
   a form, or navigating, the page DOM may change. Always call
   browser_snapshot again before performing further interactions.

4. **Ref format** — refs are strings like "e1", "e42". Only use refs that
   appeared in the most recent browser_snapshot output.

## Error code meanings

| Code       | Meaning                                | What to do                             |
|------------|----------------------------------------|----------------------------------------|
| STALE_REF  | Ref or snapshot is outdated            | Call browser_snapshot, retry action    |
| TIMEOUT    | Element/navigation timed out           | Call browser_wait or browser_snapshot  |
| NOT_FOUND  | Element was never in the snapshot      | Call browser_snapshot to see the page  |
| EXTERNAL   | Network/JS error on the page           | Check the URL, retry or investigate    |
| INTERNAL   | Page closed/crashed unexpectedly       | Report error; re-navigate if needed    |
| PERMISSION | Blocked by CORS or browser policy      | Check allowed domains in config        |
| VALIDATION | Bad argument (wrong ref format, etc.)  | Fix the argument and retry             |

## Snapshot-act-snapshot example

\`\`\`
browser_snapshot()
  → { snapshotId: "snap-tab-1-3", snapshot: "...[button] Log in [ref=e2]..." }

browser_click({ ref: "e2", snapshotId: "snap-tab-1-3" })
  → { success: true }

// Page may have changed after click — re-snapshot before next action
browser_snapshot()
  → { snapshotId: "snap-tab-1-4", snapshot: "...[input] Email [ref=e5]..." }

browser_type({ ref: "e5", snapshotId: "snap-tab-1-4", value: "user@example.com" })
  → { success: true }
\`\`\`
`.trim();

/**
 * All browser operation names in default order.
 * NOTE: "evaluate" is intentionally excluded from the default set.
 * It uses `promoted` trust tier and must be explicitly opted in.
 */
export const OPERATIONS = [
  "snapshot",
  "navigate",
  "click",
  "hover",
  "press",
  "type",
  "select",
  "fill_form",
  "scroll",
  "screenshot",
  "wait",
  "tab_new",
  "tab_close",
  "tab_focus",
  "console",
] as const;

/** All operations including the promoted-tier evaluate. */
export const ALL_OPERATIONS = [
  "snapshot",
  "navigate",
  "click",
  "hover",
  "press",
  "type",
  "select",
  "fill_form",
  "scroll",
  "screenshot",
  "wait",
  "tab_new",
  "tab_close",
  "tab_focus",
  "console",
  "evaluate",
] as const;

export type BrowserOperation = (typeof ALL_OPERATIONS)[number];

/**
 * The `evaluate` operation uses `promoted` trust tier.
 * It is excluded from OPERATIONS and must be explicitly added.
 */
export const EVALUATE_OPERATION = "evaluate" as const;

/** Trust tier for evaluate — higher than the default "verified". */
export const EVALUATE_TRUST_TIER = "promoted" as const;
