/**
 * ToolCallBlock — renders a tool call with its lifecycle states.
 *
 * Shows tool name + spinner while running, tool name + result when complete,
 * and tool name + error styling on failure. Arguments displayed via <code>.
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";

type ToolCallData = TuiAssistantBlock & { readonly kind: "tool_call" };

interface ToolCallBlockProps {
  readonly block: ToolCallData;
}

/** Spinner frames for running tool calls. */
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function StatusIndicator(props: { readonly status: ToolCallData["status"] }): JSX.Element {
  switch (props.status) {
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

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  const resultText = () => props.block.status === "complete" ? formatResult(props.block.result) : "";

  return (
    <box flexDirection="column" paddingLeft={1}>
      <box flexDirection="row" gap={1}>
        <StatusIndicator status={props.block.status} />
        <text>
          <b>{props.block.toolName}</b>
        </text>
      </box>
      <Show when={props.block.args !== undefined && props.block.args !== ""}>
        <box paddingLeft={2}>
          <text fg="gray">{props.block.args}</text>
        </box>
      </Show>
      <Show when={resultText() !== ""}>
        <box paddingLeft={2}>
          <text fg="gray">{resultText()}</text>
        </box>
      </Show>
    </box>
  );
}
