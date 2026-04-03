/**
 * ToolCallBlock — renders a tool call with its lifecycle states.
 *
 * Shows tool name + spinner while running, tool name + result when complete,
 * and tool name + error styling on failure. Arguments displayed via <code>.
 */

import type { ReactNode } from "react";
import type { TuiAssistantBlock } from "../state/types.js";

type ToolCallData = TuiAssistantBlock & { readonly kind: "tool_call" };

interface ToolCallBlockProps {
  readonly block: ToolCallData;
}

/** Spinner frames for running tool calls. */
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function StatusIndicator({ status }: { readonly status: ToolCallData["status"] }): ReactNode {
  switch (status) {
    case "running":
      return <text fg="cyan">{SPINNER[0]}</text>;
    case "complete":
      return <text fg="green">✓</text>;
    case "error":
      return <text fg="red">✗</text>;
  }
}

/** Results are pre-capped strings from the reducer (capResult). */
function formatResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  // Fallback for any non-string that bypassed the reducer
  try {
    return JSON.stringify(result);
  } catch {
    return "[unrenderable result]";
  }
}

export function ToolCallBlock({ block }: ToolCallBlockProps): ReactNode {
  const resultText = block.status === "complete" ? formatResult(block.result) : "";

  return (
    <box flexDirection="column" paddingLeft={1}>
      <box flexDirection="row" gap={1}>
        <StatusIndicator status={block.status} />
        <text>
          <b>{block.toolName}</b>
        </text>
      </box>
      {block.args !== undefined && block.args !== "" && (
        <box paddingLeft={2}>
          <text fg="gray">{block.args}</text>
        </box>
      )}
      {resultText !== "" && (
        <box paddingLeft={2}>
          <text fg="gray">{resultText}</text>
        </box>
      )}
    </box>
  );
}
