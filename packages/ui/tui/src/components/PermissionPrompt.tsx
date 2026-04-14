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

  // Register keyboard handler — without this, y/n/a keys are never received.
  // #1730: always preventDefault while this prompt is focused so non-matching
  // keys (letters from a mis-timed tmux send-keys, paste bursts, etc.) cannot
  // fall through to the textarea behind the modal and resurface as a ghost
  // user turn after the prompt is dismissed. The comment on
  // processPermissionKey's default case ("swallow — focus trap") already
  // reflects this intent; the handler now enforces it.
  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    key.preventDefault();
    const decision = processPermissionKey(key.name, permanentAvailable());
    if (decision !== null) {
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
      {...MODAL_POSITION}
    >
      {/* Title */}
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.white}><b>{"Permission Required"}</b></text>
        <text fg={riskColor()}>{`[${riskLabel()}]`}</text>
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

      {/* Tool info */}
      <box flexDirection="column" marginTop={1}>
        <text fg={COLORS.textSecondary}>{`Tool: `}<b>{props.prompt.toolId}</b></text>
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

      {/* Key hints — always-allow copy explicitly names the tool and scope */}
      <Show when={props.focused}>
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg={COLORS.success}>{"[y] Allow once"}</text>
          <text fg={COLORS.danger}>{"[n] Deny"}</text>
          <text fg={COLORS.blueAccent}>{`[a] Always allow ${props.prompt.toolId} this session`}</text>
          <Show when={permanentAvailable()}>
            <text fg={COLORS.amber}>{`[!] Always (permanent)`}</text>
          </Show>
          <text fg={COLORS.textMuted}>{"[Esc] Dismiss"}</text>
        </box>
      </Show>
    </box>
  );
}
