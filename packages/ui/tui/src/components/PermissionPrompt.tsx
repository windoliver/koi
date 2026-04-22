/**
 * PermissionPrompt — modal overlay for HITL tool approval.
 *
 * Single-key responses (proven UX pattern from Claude Code / OpenCode):
 *   y = allow once
 *   n = deny
 *   a = always-allow (session-scoped)
 *   Escape = deny and dismiss
 *
 * Rendered as an absolute-positioned overlay via OpenTUI <box>.
 * Parent handles focus: when this is visible, useKeyboard routes here.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { ApprovalDecision } from "@koi/core/middleware";
import type { PermissionPromptData, PermissionRiskLevel } from "../state/types.js";
import { COLORS, MODAL_POSITION } from "../theme.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Preferred outer width for the permission prompt modal.
 * Must be a positive integer — OpenTUI absolute-positioned boxes without an
 * explicit width re-measure content every layout pass, triggering a
 * blendCells busy-loop that saturates one CPU core and blocks all input.
 * The actual rendered width is clamped to available terminal columns so the
 * modal remains fully visible on narrow terminals (< 64 cols). (#1913)
 */
export const PERMISSION_PROMPT_WIDTH = 60;

/**
 * Border chrome: 1 col left + 1 col right. Subtracted from the available
 * columns so the outer box (left_offset + width + borders) never exceeds
 * the terminal column count.
 */
const BORDER_CHROME = 2;

/**
 * Minimum positive width passed to the OpenTUI <box>. A zero or absent width
 * causes OpenTUI to re-measure the content every layout pass, triggering the
 * blendCells busy-loop that saturates one CPU core and blocks all input.
 * 1 is the smallest value that avoids the busy-loop.
 */
const PERMISSION_PROMPT_MIN_WIDTH = 1;

/**
 * Compute the clamped modal width for a given terminal column count.
 * Guarantees: result >= PERMISSION_PROMPT_MIN_WIDTH (positive integer, avoids
 * blendCells busy-loop); result <= PERMISSION_PROMPT_WIDTH on wide terminals.
 * For pathologically narrow terminals (< left + border = 4 cols) the left
 * offset already overflows the terminal — width is clamped to the minimum so
 * OpenTUI still has an explicit positive width and does not enter the loop.
 * Exported for unit testing without needing a render context.
 */
export function computePermissionPromptWidth(terminalCols: number): number {
  const available = terminalCols - MODAL_POSITION.left - BORDER_CHROME;
  return Math.min(PERMISSION_PROMPT_WIDTH, Math.max(available, PERMISSION_PROMPT_MIN_WIDTH));
}

/**
 * Modal widths below this threshold stack the title-row risk label onto its own
 * line. At PERMISSION_PROMPT_WIDTH=60 the inner width is 58, comfortably fitting
 * "Permission Required [MEDIUM] (1 of 9)" (38 chars). Only below 30 cols does
 * the heading start to clip its metadata.
 *
 * Key hints are always rendered as a vertical stack regardless of this threshold:
 * the full horizontal row is ~76 chars, which never fits in the max 60-col modal.
 * Exported for unit testing.
 */
export const PERMISSION_PROMPT_NARROW_THRESHOLD = 30;

/**
 * Minimum modal width at which the prompt can display enough approval context
 * to be safely interactive. Below this (terminal < ~24 cols), the keyboard
 * handler suppresses y/a/! and shows a "resize terminal" fallback so users
 * cannot accidentally grant access to an unreadable prompt. Only Escape/deny
 * remains active. Exported for unit testing.
 */
export const PERMISSION_PROMPT_MIN_SAFE_WIDTH = 20;

const RISK_COLORS: Record<PermissionRiskLevel, string> = {
  low: COLORS.success,
  medium: COLORS.amber,
  high: COLORS.danger,
};

const RISK_LABELS: Record<PermissionRiskLevel, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionPromptProps {
  /** The prompt data from the permission bridge. */
  readonly prompt: PermissionPromptData;
  /** Called when the user makes a decision. */
  readonly onRespond: (requestId: string, decision: ApprovalDecision) => void;
  /** Whether this prompt has keyboard focus. */
  readonly focused: boolean;
  /**
   * Current terminal column count, forwarded from the parent that owns
   * useTerminalDimensions(). Used to clamp modal width on narrow terminals
   * so approval context is never clipped off-screen (#1913).
   * Defaults to PERMISSION_PROMPT_WIDTH when not provided.
   */
  readonly terminalWidth?: number | undefined;
}

// ---------------------------------------------------------------------------
// Key handling (pure, exported for testing)
// ---------------------------------------------------------------------------

/** Map a key name to an ApprovalDecision, or null if not a valid response.
 *  When permanentAvailable is false, the `!` key is ignored. */
export function processPermissionKey(keyName: string, permanentAvailable = false): ApprovalDecision | null {
  switch (keyName.toLowerCase()) {
    case "y":
      return { kind: "allow" };
    case "n":
      return { kind: "deny", reason: "User denied" };
    case "a":
      return { kind: "always-allow", scope: "session" };
    case "!":
      return permanentAvailable ? { kind: "always-allow", scope: "always" } : null;
    case "escape":
      return { kind: "deny", reason: "User dismissed" };
    default:
      return null; // swallow — focus trap
  }
}

/**
 * Truncate a tool ID for display when the available width is narrow.
 * The full `toolId` is preserved in the prompt's `Tool:` label and in
 * the `[a]` always-allow hint; `maxLen` limits the inline display copy
 * so MCP-style IDs such as `crm__get_customer` don't dominate the layout
 * on 40-col terminals.
 */
export function formatToolId(toolId: string, maxLen: number): string {
  if (toolId.length <= maxLen) return toolId;
  return toolId.slice(0, maxLen - 1) + "…";
}

/** Format the input object for display (truncated for large inputs). */
export function formatInputPreview(input: Record<string, unknown>, maxLength = 200): string {
  const json = JSON.stringify(input, null, 2);
  if (json.length <= maxLength) return json;
  return json.slice(0, maxLength) + "\n  ...";
}

/**
 * Normalize whitespace in a permission reason string for display: collapse
 * runs of whitespace to single spaces and trim leading/trailing whitespace.
 * Does NOT truncate — the full text must be visible at the approval
 * boundary (the distinguishing detail can be near the end of the string).
 * The component's `<text>` element is responsible for line-wrapping.
 * (#1759 review round 8)
 */
export function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionPrompt(props: PermissionPromptProps): JSX.Element {
  const inputPreview = createMemo(() => formatInputPreview(props.prompt.input));
  const riskColor = createMemo(() => RISK_COLORS[props.prompt.riskLevel]);
  const riskLabel = createMemo(() => RISK_LABELS[props.prompt.riskLevel]);

  const permanentAvailable = createMemo(() => props.prompt.permanentAvailable === true);

  // Clamp to available columns so the approval context is never clipped on
  // narrow terminals. Width is driven by the parent's terminal-resize signal —
  // not per-frame — so this does not reintroduce the blendCells busy-loop.
  // Falls back to PERMISSION_PROMPT_WIDTH when terminalWidth is not provided
  // (e.g. unit tests that only exercise pure logic). (#1913)
  const modalWidth = createMemo(() =>
    computePermissionPromptWidth(props.terminalWidth ?? PERMISSION_PROMPT_WIDTH)
  );

  // Stacked layout when the computed modal width is below the threshold where
  // horizontal hint rows would overflow. (#1913)
  const isNarrow = createMemo(() => modalWidth() < PERMISSION_PROMPT_NARROW_THRESHOLD);

  // Below the minimum safe width the prompt cannot display enough context to
  // make an informed decision. Approval keys are suppressed; only Escape/deny
  // remains active so the user can dismiss and resize the terminal. (#1913)
  const isTooNarrow = createMemo(() => modalWidth() < PERMISSION_PROMPT_MIN_SAFE_WIDTH);

  // Register keyboard handler — without this, y/n/a keys are never received
  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (isTooNarrow()) {
      // Context is unreadable: suppress approval (y/a/!) but keep explicit
      // deny (n) and dismiss (Escape) so the user can fail closed immediately.
      const name = key.name.toLowerCase();
      if (name === "escape") {
        key.preventDefault();
        props.onRespond(props.prompt.requestId, { kind: "deny", reason: "User dismissed" });
      } else if (name === "n") {
        key.preventDefault();
        props.onRespond(props.prompt.requestId, { kind: "deny", reason: "User denied" });
      }
      return;
    }
    const decision = processPermissionKey(key.name, permanentAvailable());
    if (decision !== null) {
      key.preventDefault();
      props.onRespond(props.prompt.requestId, decision);
    }
  });

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={riskColor()}
      paddingLeft={1}
      paddingRight={1}
      width={modalWidth()}
      {...MODAL_POSITION}
    >
      {/* Safety guard: when the terminal is too narrow to show meaningful
          approval context, render a non-interactive message. Approval (y/a/!)
          is suppressed; explicit deny (n) and dismiss (Esc) remain active so
          the user can fail closed while resizing the terminal. */}
      <Show when={isTooNarrow()}>
        <text fg={COLORS.amber}>{"Resize\nto review"}</text>
        <text fg={COLORS.textMuted}>{"[n] Deny  [Esc]"}</text>
      </Show>
      <Show when={!isTooNarrow()}>

      {/* Title — stacks risk label below the heading on narrow terminals so
          "Permission Required [MEDIUM] (1 of 9)" (38+ chars) never clips. */}
      <box flexDirection={isNarrow() ? "column" : "row"} gap={isNarrow() ? 0 : 1}>
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.white}><b>{"Permission Required"}</b></text>
          <Show when={!isNarrow()}>
            <text fg={riskColor()}>{`[${riskLabel()}]`}</text>
          </Show>
        </box>
        <box flexDirection="row" gap={1}>
          <Show when={isNarrow()}>
            <text fg={riskColor()}>{`[${riskLabel()}]`}</text>
          </Show>
          {/* Counter hint — shows queue position when multiple prompts are
              pending in the bridge queue, OR the monotonically incrementing
              sequence number when prompts arrive one at a time (the common
              engine-serialized case). Lets the user tell that the prompt
              that appeared after pressing y is a NEW tool call, not a
              re-render of the same one. (#1759) */}
          <Show
            when={(props.prompt.queueDepth ?? 0) > 1}
            fallback={
              <Show when={props.prompt.sequenceNumber !== undefined}>
                <text fg={COLORS.amber}>{`#${props.prompt.sequenceNumber}`}</text>
              </Show>
            }
          >
            <text fg={COLORS.amber}>
              {`(${props.prompt.queuePosition ?? 1} of ${props.prompt.queueDepth})`}
            </text>
          </Show>
        </box>
      </box>

      {/* Tool info — on narrow terminals the toolId goes on its own line so
          the full authorization target remains visible without truncation. */}
      <box flexDirection="column" marginTop={1}>
        <Show
          when={isNarrow()}
          fallback={
            <text fg={COLORS.textSecondary}>{`Tool: `}<b>{props.prompt.toolId}</b></text>
          }
        >
          <text fg={COLORS.textSecondary}>{"Tool:"}</text>
          <text fg={COLORS.white}>{`  ${props.prompt.toolId}`}</text>
        </Show>
      </box>

      {/* Args preview */}
      <box marginTop={1}>
        <text fg={COLORS.textMuted}>{`Arguments:\n${inputPreview()}`}</text>
      </box>

      {/* Reason — kept visible at the approval boundary as a safety
          signal (round-3 + round-8 reviews of #1759). Rendered in dim
          text without a prominent "Reason:" label so it doesn't dominate
          the prompt the way the original two-line layout did, but the
          full text is preserved (no truncation) and wraps naturally so
          the user can see the distinguishing detail at the END of long
          policy explanations (path / rule / host that triggered the ask). */}
      <Show when={props.prompt.reason !== undefined && props.prompt.reason !== ""}>
        <box marginTop={1}>
          <text fg={COLORS.textMuted}>{`↳ ${normalizeReason(props.prompt.reason)}`}</text>
        </box>
      </Show>

      {/* Key hints — always stacked vertically. The full horizontal row is ~76
          chars, which exceeds the max modal width (60), so a single-row layout
          would always clip hints. Stacked layout ensures all actions are visible
          at every supported terminal width. The [a] hint breaks the toolId onto
          its own line so the full authorization target is readable (no truncation). */}
      <Show when={props.focused}>
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.success}>{"[y] Allow once"}</text>
          <text fg={COLORS.danger}>{"[n] Deny"}</text>
          <text fg={COLORS.blueAccent}>{`[a] Allow this session:\n  ${props.prompt.toolId}`}</text>
          <Show when={permanentAvailable()}>
            <text fg={COLORS.amber}>{`[!] Always (permanent)`}</text>
          </Show>
          <text fg={COLORS.textMuted}>{"[Esc] Dismiss"}</text>
        </box>
      </Show>

      </Show> {/* isTooNarrow() guard */}
    </box>
  );
}
