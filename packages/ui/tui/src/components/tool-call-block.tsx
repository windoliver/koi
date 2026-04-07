/**
 * ToolCallBlock — renders a tool call with structured title/subtitle/chips display.
 *
 * While streaming (status "running"), shows the raw tool name — args are partial
 * JSON and cannot be parsed. On completion, switches to the structured display:
 * human-readable title, most-important-arg subtitle, and scalar chips.
 *
 * Result rendering (Phase 3): extracts scalar metadata chips (exitCode, status,
 * bytesWritten, etc.) and displays the main content body separately.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { Accessor, JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { COLORS } from "../theme.js";
import {
  getResultDisplay,
  getToolDisplay,
  type ResultDisplay,
  type ToolDisplay,
} from "../tool-display.js";

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
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return getToolDisplay(block.toolName, parsed as Readonly<Record<string, unknown>>);
      }
      return getToolDisplay(block.toolName, {});
    } catch {
      return getToolDisplay(block.toolName, {});
    }
  });
}

/** Parse result string into chips + body. Only runs on completion. */
function useResultDisplay(block: ToolCallData): Accessor<ResultDisplay | null> {
  return createMemo((): ResultDisplay | null => {
    if (block.status !== "complete") return null;
    const result = block.result;
    if (result === undefined || result === "") return null;
    return getResultDisplay(result);
  });
}

/** Renders highlighted or plain text, deduplicating the Show pattern (Decision 5A). */
function HighlightedText(props: {
  readonly content: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly filetype?: string | undefined;
}): JSX.Element {
  return (
    <Show
      when={props.syntaxStyle}
      fallback={<text fg={COLORS.textMuted}>{props.content}</text>}
    >
      {(style: Accessor<SyntaxStyle>) => (
        <code content={props.content} syntaxStyle={style()} filetype={props.filetype ?? "json"} />
      )}
    </Show>
  );
}

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  const display = useToolDisplay(props.block);
  const resultDisplay = useResultDisplay(props.block);

  /** Merge arg chips and result chips for the chips row. */
  const allChips = createMemo((): readonly string[] => {
    const argChips = display()?.chips ?? [];
    const resChips = resultDisplay()?.chips ?? [];
    if (resChips.length === 0) return argChips;
    if (argChips.length === 0) return resChips;
    return [...argChips, ...resChips];
  });

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

      {/* Chips row — arg chips + result chips merged */}
      <Show when={allChips().length > 0}>
        <box flexDirection="row" gap={1} paddingLeft={2}>
          <For each={allChips()}>
            {(chip: string) => <text fg={COLORS.textMuted}>{chip}</text>}
          </For>
        </box>
      </Show>

      {/* Result body — shown on completion */}
      <Show when={resultDisplay()?.body}>
        {(body: Accessor<string>) => (
          <box paddingLeft={2}>
            <HighlightedText content={body()} syntaxStyle={props.syntaxStyle} />
          </box>
        )}
      </Show>
    </box>
  );
}
