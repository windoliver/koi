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
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useMemo } from "react";
import type { ApprovalDecision } from "@koi/core/middleware";
import type { PermissionPromptData, PermissionRiskLevel } from "../state/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RISK_COLORS: Record<PermissionRiskLevel, string> = {
  low: "#4ADE80",     // green
  medium: "#FBBF24",  // amber
  high: "#F87171",    // red
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
  switch (keyName) {
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

export const PermissionPrompt: React.NamedExoticComponent<PermissionPromptProps> = memo(function PermissionPrompt(
  props: PermissionPromptProps,
): React.ReactNode {
  const { prompt, onRespond, focused } = props;

  const inputPreview = useMemo(() => formatInputPreview(prompt.input), [prompt.input]);
  const riskColor = RISK_COLORS[prompt.riskLevel];
  const riskLabel = RISK_LABELS[prompt.riskLevel];

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (!focused) return;
      const decision = processPermissionKey(key.name);
      if (decision !== null) {
        key.preventDefault();
        onRespond(prompt.requestId, decision);
      }
    },
    [prompt.requestId, onRespond, focused],
  );

  // Register keyboard handler — without this, y/n/a keys are never received
  useKeyboard(handleKey);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={riskColor}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Title */}
      <box flexDirection="row" gap={1}>
        <text fg="#E2E8F0"><b>{"Permission Required"}</b></text>
        <text fg={riskColor}>{`[${riskLabel}]`}</text>
      </box>

      {/* Tool info */}
      <box flexDirection="column" marginTop={1}>
        <text fg="#94A3B8">{`Tool: `}<b>{prompt.toolId}</b></text>
        <text fg="#94A3B8">{`Reason: ${prompt.reason}`}</text>
      </box>

      {/* Args preview */}
      <box marginTop={1}>
        <text fg="#64748B">{`Arguments:\n${inputPreview}`}</text>
      </box>

      {/* Key hints — always-allow copy explicitly names the tool and scope */}
      {focused ? (
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg="#4ADE80">{"[y] Allow once"}</text>
          <text fg="#F87171">{"[n] Deny"}</text>
          <text fg="#60A5FA">{`[a] Always allow ${prompt.toolId} this session`}</text>
          <text fg="#64748B">{"[Esc] Dismiss"}</text>
        </box>
      ) : null}
    </box>
  );
});
