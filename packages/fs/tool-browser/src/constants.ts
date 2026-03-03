/**
 * Constants for @koi/tool-browser — tool names, operations, and SDK mappings.
 */

import type { SkillComponent } from "@koi/core";

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

/** All operations including promoted-tier and opt-in operations. */
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
  "upload",
  "trace_start",
  "trace_stop",
] as const;

export type BrowserOperation = (typeof ALL_OPERATIONS)[number];

/**
 * The `evaluate` operation uses `promoted` trust tier.
 * It is excluded from OPERATIONS and must be explicitly added.
 */
export const EVALUATE_OPERATION = "evaluate" as const;

/** Trust tier for evaluate — higher than the default "verified". */
export const EVALUATE_TRUST_TIER = "promoted" as const;

/**
 * The `upload` operation writes files to the server process.
 * It is excluded from OPERATIONS and must be explicitly added.
 */
export const UPLOAD_OPERATION = "upload" as const;

/**
 * Trace recording operations — debug-only.
 * Excluded from OPERATIONS and must be explicitly added.
 */
export const TRACE_OPERATION_START = "trace_start" as const;
export const TRACE_OPERATION_STOP = "trace_stop" as const;

/** Skill component name for browser automation behavioral guidance. */
export const BROWSER_SKILL_NAME = "browser" as const;

/**
 * Markdown content for the browser skill component.
 * Teaches agents the snapshot-first workflow, form filling, wait strategies,
 * tab management, and trust tier awareness.
 *
 * References the default prefix (`browser_*`). Agents using a custom prefix
 * should substitute the appropriate tool names when applying this guidance.
 */
export const BROWSER_SKILL_CONTENT: string = `
# Browser automation — snapshot-first workflow

## Core loop: snapshot → act → re-snapshot

Always follow this loop when operating the browser:

1. **browser_snapshot** — call before every action.
   Returns \`snapshotId\` and a list of interactive elements with \`[ref=eN]\` markers
   (e.g., \`[button] Submit [ref=e3]\`).

2. **Pass \`snapshotId\` to every action** — include the \`snapshotId\` from the latest
   snapshot in every interaction call (browser_click, browser_type, browser_fill_form, etc.).
   Stale IDs cause STALE_REF errors immediately rather than acting on wrong elements.

3. **Re-snapshot after DOM changes** — after clicking, submitting a form, or navigating,
   always call browser_snapshot again before performing further interactions.

4. **Ref format** — refs are strings like "e1", "e42". Only use refs from the most recent
   browser_snapshot output.

## Form filling

- **Multi-field forms**: use **browser_fill_form** — submits all fields atomically with a
  single call. Pass a \`fields\` array: \`[{ ref: "e5", value: "user@example.com" }, ...]\`
- **Single field**: use **browser_type** — then snapshot to confirm the value was accepted.
- **Dropdowns / select elements**: use **browser_select** with the option *value* (not label).
- **File upload**: use **browser_upload** (requires the \`upload\` operation to be enabled).
- After submitting a form, always re-snapshot to confirm navigation or a success indicator.

## Wait strategies

- After **browser_navigate**: re-snapshot; use **browser_wait** if expected elements are absent.
- **browser_wait with \`selector\`**: waits for a specific element to appear — prefer this over
  fixed time delays.
- **browser_wait with \`timeout\`**: maximum ms to wait. Keep under 10 000 to avoid hanging.
- Do not retry actions in a tight loop without a wait or snapshot in between.

## Tab management

- **browser_tab_new** — opens a new tab at a URL; returns a tab ID.
- **browser_tab_focus(tabId)** — switch to a specific tab before acting on it.
  Snapshots are tab-scoped: after browser_tab_focus, always call browser_snapshot.
- **browser_tab_close(tabId)** — close a tab when done. Always close tabs you open.

## Trust tier awareness

- Most browser tools run at **verified** trust tier (the default).
- **browser_evaluate** runs at **promoted** trust tier — requires explicit opt-in in the
  provider config. Use it only when no other browser tool achieves the goal; prefer
  browser_click, browser_type, and browser_fill_form over browser_evaluate.
- **browser_screenshot** returns base64 image data and is token-expensive.
  Prefer **browser_snapshot** (accessibility tree text) — roughly 100× cheaper in tokens.
  Use browser_screenshot only for visual debugging or when image content is necessary.

## Error code quick reference

| Code       | Meaning                              | What to do                              |
|------------|--------------------------------------|-----------------------------------------|
| STALE_REF  | Ref or snapshot is outdated          | Call browser_snapshot, retry action     |
| TIMEOUT    | Element/navigation timed out         | Call browser_wait or browser_snapshot   |
| NOT_FOUND  | Element was never in the snapshot    | Call browser_snapshot to see the page   |
| EXTERNAL   | Network/JS error on the page         | Check the URL, retry or investigate     |
| INTERNAL   | Page closed/crashed unexpectedly     | Report error; re-navigate if needed     |
| PERMISSION | Blocked by CORS or browser policy    | Check allowed domains in config         |
| VALIDATION | Bad argument (wrong ref format, etc.)| Fix the argument and retry              |
`.trim();

/**
 * Pre-built SkillComponent for browser automation behavioral guidance.
 * Attached automatically by createBrowserProvider.
 * Can also be used standalone with a custom ComponentProvider.
 */
export const BROWSER_SKILL: SkillComponent = {
  name: BROWSER_SKILL_NAME,
  description:
    "Snapshot-first workflow, form filling, wait strategies, tab management, and trust tier awareness for browser automation",
  content: BROWSER_SKILL_CONTENT,
  tags: ["browser", "best-practices"],
} as const satisfies SkillComponent;
