/**
 * ToolCallBlock — renders a tool call with its lifecycle states.
 *
 * When `syntaxStyle` is provided (tree-sitter available), args and result are
 * rendered with JSON syntax highlighting via OpenTUI's <code> component.
 * Otherwise plain <text> is used as a fallback.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { Accessor, JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { COLORS } from "../theme.js";

type ToolCallData = TuiAssistantBlock & { readonly kind: "tool_call" };

interface ToolCallBlockProps {
  readonly block: ToolCallData;
  readonly spinnerFrame: Accessor<number>;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function StatusIndicator(props: {
  readonly status: ToolCallData["status"];
  readonly spinnerFrame: Accessor<number>;
}): JSX.Element {
  switch (props.status) {
    case "running":
      return <text fg={COLORS.cyan}>{SPINNER[props.spinnerFrame() % SPINNER.length] ?? "⠋"}</text>;
    case "complete":
      return <text fg={COLORS.success}>✓</text>;
    case "error":
      return <text fg={COLORS.danger}>✗</text>;
  }
}

function formatResult(result: unknown, toolName: string): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return `[result of ${toolName} could not be serialized]`;
  }
}

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  // createMemo ensures JSON.stringify only runs when result/status change,
  // not on every spinnerFrame tick.
  const resultText = createMemo(() =>
    props.block.status === "complete"
      ? formatResult(props.block.result, props.block.toolName)
      : "",
  );

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
          <Show
            when={props.syntaxStyle}
            fallback={<text fg={COLORS.textMuted}>{props.block.args}</text>}
          >
            {(style: () => SyntaxStyle) => (
              <code content={props.block.args ?? ""} syntaxStyle={style()} filetype="json" />
            )}
          </Show>
        </box>
      </Show>
      <Show when={resultText() !== ""}>
        <box paddingLeft={2}>
          <Show
            when={props.syntaxStyle}
            fallback={<text fg={COLORS.textMuted}>{resultText()}</text>}
          >
            {(style: () => SyntaxStyle) => (
              <code content={resultText()} syntaxStyle={style()} filetype="json" />
            )}
          </Show>
        </box>
      </Show>
    </box>
  );
}
