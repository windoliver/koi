/**
 * ToolCallBlock — renders a tool call with its lifecycle states.
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { COLORS } from "../theme.js";

type ToolCallData = TuiAssistantBlock & { readonly kind: "tool_call" };

interface ToolCallBlockProps {
  readonly block: ToolCallData;
  readonly spinnerFrame: number;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function StatusIndicator(props: {
  readonly status: ToolCallData["status"];
  readonly spinnerFrame: number;
}): JSX.Element {
  switch (props.status) {
    case "running":
      return <text fg={COLORS.cyan}>{SPINNER[props.spinnerFrame % SPINNER.length] ?? "⠋"}</text>;
    case "complete":
      return <text fg={COLORS.success}>✓</text>;
    case "error":
      return <text fg={COLORS.danger}>✗</text>;
  }
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return "[unrenderable result]";
  }
}

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  const resultText = () =>
    props.block.status === "complete" ? formatResult(props.block.result) : "";

  return (
    <box flexDirection="column" paddingLeft={1}>
      <box flexDirection="row" gap={1}>
        <StatusIndicator status={props.block.status} spinnerFrame={props.spinnerFrame} />
        <text>
          <b>{props.block.toolName}</b>
        </text>
      </box>
      <Show when={props.block.args !== undefined && props.block.args !== ""}>
        <box paddingLeft={2}>
          <text fg={COLORS.textMuted}>{props.block.args}</text>
        </box>
      </Show>
      <Show when={resultText() !== ""}>
        <box paddingLeft={2}>
          <text fg={COLORS.textMuted}>{resultText()}</text>
        </box>
      </Show>
    </box>
  );
}
