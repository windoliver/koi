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
import { COLORS } from "../theme.js";

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

/** Map a key name to an ApprovalDecision, or null if not a valid response. */
export function processPermissionKey(keyName: string): ApprovalDecision | null {
  switch (keyName.toLowerCase()) {
    case "y":
      return { kind: "allow" };
    case "n":
      return { kind: "deny", reason: "User denied" };
    case "a":
      return { kind: "always-allow", scope: "session" };
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionPrompt(props: PermissionPromptProps): JSX.Element {
  const inputPreview = createMemo(() => formatInputPreview(props.prompt.input));
  const riskColor = createMemo(() => RISK_COLORS[props.prompt.riskLevel]);
  const riskLabel = createMemo(() => RISK_LABELS[props.prompt.riskLevel]);

  // Register keyboard handler — without this, y/n/a keys are never received
  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    const decision = processPermissionKey(key.name);
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
    >
      {/* Title */}
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.white}><b>{"Permission Required"}</b></text>
        <text fg={riskColor()}>{`[${riskLabel()}]`}</text>
      </box>

      {/* Tool info */}
      <box flexDirection="column" marginTop={1}>
        <text fg={COLORS.textSecondary}>{`Tool: `}<b>{props.prompt.toolId}</b></text>
        <text fg={COLORS.textSecondary}>{`Reason: ${props.prompt.reason}`}</text>
      </box>

      {/* Args preview */}
      <box marginTop={1}>
        <text fg={COLORS.textMuted}>{`Arguments:\n${inputPreview()}`}</text>
      </box>

      {/* Key hints — always-allow copy explicitly names the tool and scope */}
      <Show when={props.focused}>
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg={COLORS.success}>{"[y] Allow once"}</text>
          <text fg={COLORS.danger}>{"[n] Deny"}</text>
          <text fg={COLORS.blueAccent}>{`[a] Always allow ${props.prompt.toolId} this session`}</text>
          <text fg={COLORS.textMuted}>{"[Esc] Dismiss"}</text>
        </box>
      </Show>
    </box>
  );
}
