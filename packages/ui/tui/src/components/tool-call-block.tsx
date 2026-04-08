/**
 * ToolCallBlock — renders a tool call with structured title/subtitle/chips display.
 *
 * While streaming (status "running"), shows the raw tool name — args are partial
 * JSON and cannot be parsed. On completion, switches to the structured display:
 * human-readable title, most-important-arg subtitle, and scalar chips.
 *
 * Features:
 * - Accordion collapse: tool results collapsed by default (Decision 15A).
 *   Click title row or Ctrl+E (global toggle) to expand.
 * - Diff display: `_edit` tools render unified diffs via OpenTUI <diff> component.
 * - Result rendering: extracts scalar metadata chips and displays content body.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { Accessor, JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { computeEditDiff } from "../utils/compute-edit-diff.js";
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

/** Extract parsed args object for diff computation. Only for _edit tools. */
function useParsedArgs(block: ToolCallData): Accessor<Readonly<Record<string, unknown>> | null> {
  return createMemo((): Readonly<Record<string, unknown>> | null => {
    if (block.status !== "complete") return null;
    if (!block.toolName.endsWith("_edit")) return null;
    const raw = block.args;
    if (raw === undefined || raw === "") return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
      return null;
    } catch {
      return null;
    }
  });
}

/**
 * Compute unified diff string for _edit tools.
 *
 * Supports two schemas:
 * - Legacy/external: `{ file_path, old_string, new_string }` (single hunk)
 * - First-party fs_edit: `{ path, edits: [{ oldText, newText }, ...] }` (multi-hunk)
 */
function useEditDiff(block: ToolCallData): Accessor<string | null> {
  const parsedArgs = useParsedArgs(block);
  return createMemo((): string | null => {
    const args = parsedArgs();
    if (args === null) return null;

    // First-party fs_edit schema: { path, edits: [{ oldText, newText }] }
    const edits = args.edits;
    if (Array.isArray(edits) && edits.length > 0) {
      const filePath = typeof args.path === "string" ? args.path : undefined;
      const parts: string[] = [];
      for (const edit of edits) {
        if (typeof edit === "object" && edit !== null && !Array.isArray(edit)) {
          const e = edit as Readonly<Record<string, unknown>>;
          const oldStr = typeof e.oldText === "string" ? e.oldText : "";
          const newStr = typeof e.newText === "string" ? e.newText : "";
          if (oldStr !== "" || newStr !== "") {
            parts.push(computeEditDiff(oldStr, newStr, filePath));
          }
        }
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }

    // Legacy/external schema: { file_path, old_string, new_string }
    const oldStr = typeof args.old_string === "string" ? args.old_string : "";
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    if (oldStr === "" && newStr === "") return null;
    const filePath = typeof args.file_path === "string" ? args.file_path : undefined;
    return computeEditDiff(oldStr, newStr, filePath);
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

/** Extract file extension from a file path for syntax highlighting. */
function getFiletype(toolName: string, args: Readonly<Record<string, unknown>> | null): string {
  if (args === null) return "text";
  const filePath = typeof args.file_path === "string" ? args.file_path : "";
  const ext = filePath.split(".").pop();
  return ext ?? "text";
}

export function ToolCallBlock(props: ToolCallBlockProps): JSX.Element {
  const display = useToolDisplay(props.block);
  const resultDisplay = useResultDisplay(props.block);
  const editDiff = useEditDiff(props.block);
  const parsedArgs = useParsedArgs(props.block);

  // Accordion: local expanded state, global toggle overrides (Decision 15A)
  const [localExpanded, setLocalExpanded] = createSignal(false);
  const globalExpanded = useTuiStore((s) => s.toolsExpanded);
  const isExpanded = createMemo(() => localExpanded() || globalExpanded());

  /** Merge arg chips and result chips for the chips row. */
  const allChips = createMemo((): readonly string[] => {
    const argChips = display()?.chips ?? [];
    const resChips = resultDisplay()?.chips ?? [];
    if (resChips.length === 0) return argChips;
    if (argChips.length === 0) return resChips;
    return [...argChips, ...resChips];
  });

  const isComplete = () => props.block.status !== "running";
  const hasBody = () => resultDisplay()?.body !== undefined && resultDisplay()?.body !== "";

  return (
    <box flexDirection="column" paddingLeft={1}>
      {/* Title row: status indicator + title + subtitle (clickable for accordion) */}
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => { if (isComplete()) setLocalExpanded((e: boolean) => !e); }}
      >
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
              {isComplete() && hasBody() ? (isExpanded() ? " ▾" : " ▸") : ""}
            </text>
          )}
        </Show>
      </box>

      {/* Chips row — always visible when present */}
      <Show when={allChips().length > 0}>
        <box flexDirection="row" gap={1} paddingLeft={2}>
          <For each={allChips()}>
            {(chip: string) => <text fg={COLORS.textMuted}>{chip}</text>}
          </For>
        </box>
      </Show>

      {/* Result body — shown only when expanded (Decision 15A) */}
      <Show when={isExpanded() && isComplete()}>
        {/* Diff rendering for _edit tools */}
        <Show when={editDiff()}>
          {(diffStr: Accessor<string>) => (
            <box paddingLeft={2}>
              <diff
                diff={diffStr()}
                view="unified"
                syntaxStyle={props.syntaxStyle}
                filetype={getFiletype(props.block.toolName, parsedArgs())}
              />
            </box>
          )}
        </Show>

        {/* Standard result body (non-diff) */}
        <Show when={editDiff() === null && resultDisplay()?.body}>
          {(body: Accessor<string>) => (
            <box paddingLeft={2}>
              <HighlightedText content={body()} syntaxStyle={props.syntaxStyle} />
            </box>
          )}
        </Show>
      </Show>
    </box>
  );
}
