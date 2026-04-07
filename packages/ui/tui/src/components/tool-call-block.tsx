/**
 * ToolCallBlock — renders a tool call with structured title/subtitle/chips display.
 *
 * While streaming (status "running"), shows the raw tool name — args are partial
 * JSON and cannot be parsed. On completion, switches to the structured display:
 * human-readable title, most-important-arg subtitle, and scalar chips.
 *
 * When `syntaxStyle` is provided, the expandable raw args/result sections use
 * JSON syntax highlighting via OpenTUI's <code> component.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { Accessor, JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { COLORS } from "../theme.js";
import { getToolDisplay, type ToolDisplay } from "../tool-display.js";

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

/**
 * Parse args JSON and produce structured display. Gated on status === "complete"
 * to avoid wasted parses during streaming (Decision 13A).
 */
function useToolDisplay(block: ToolCallData): Accessor<ToolDisplay | null> {
  return createMemo((): ToolDisplay | null => {
    if (block.status === "running") return null;
    const raw = block.args;
    if (raw === undefined || raw === "") return getToolDisplay(block.toolName, {});
    try {
      const parsed: unknown = JSON.parse(raw);
      // Guard: JSON.parse succeeds on strings, numbers, arrays, null — not just objects
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return getToolDisplay(block.toolName, parsed as Readonly<Record<string, unknown>>);
      }
      return getToolDisplay(block.toolName, {});
    } catch {
      return getToolDisplay(block.toolName, {});
    }
  });
}

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  const display = useToolDisplay(props.block);

  return (
    <box flexDirection="column" paddingLeft={1}>
      {/* Title row: status indicator + title + subtitle */}
      <box flexDirection="row" gap={1}>
        <StatusIndicator status={props.block.status} spinnerFrame={props.spinnerFrame} />
        <Show
          when={display()}
          fallback={
            <text>
              <b>{props.block.toolName}</b>
            </text>
          }
        >
          {(d: Accessor<ToolDisplay>) => (
            <text>
              <b>{d().title}</b>
              {d().subtitle !== "" ? `  ${d().subtitle}` : ""}
            </text>
          )}
        </Show>
      </box>

      {/* Chips row — secondary scalar args */}
      <Show when={display()?.chips.length}>
        <box flexDirection="row" gap={1} paddingLeft={2}>
          <For each={display()?.chips ?? []}>
            {(chip: string) => <text fg={COLORS.textMuted}>{chip}</text>}
          </For>
        </box>
      </Show>

      {/* Result — shown on completion */}
      <Show when={props.block.status === "complete" && props.block.result !== undefined && props.block.result !== ""}>
        <box paddingLeft={2}>
          <Show
            when={props.syntaxStyle}
            fallback={<text fg={COLORS.textMuted}>{props.block.result}</text>}
          >
            {(style: Accessor<SyntaxStyle>) => (
              <code content={props.block.result ?? ""} syntaxStyle={style()} filetype="json" />
            )}
          </Show>
        </box>
      </Show>
    </box>
  );
}
