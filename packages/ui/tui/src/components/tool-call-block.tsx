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
import { createMemo, For, Match, Show, Switch, useContext } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { StoreContext, useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { computeEditDiff } from "../utils/compute-edit-diff.js";
import {
  getResultDisplay,
  getToolDisplay,
  type ResultDisplay,
  type ToolDisplay,
} from "../tool-display.js";
import { DEFAULT_SPINNER } from "./spinners.js";

/** Line-count limits per tool category (#7). */
const BODY_LINE_LIMITS: Record<string, number> = {
  default: 3,
  bash: 10,
  shell: 10,
  run: 10,
};

function getBodyLineLimit(toolName: string): number {
  const lower = toolName.toLowerCase();
  for (const [key, limit] of Object.entries(BODY_LINE_LIMITS)) {
    if (key !== "default" && lower.includes(key)) return limit;
  }
  return BODY_LINE_LIMITS["default"] ?? 3;
}

/** Format duration as human-readable string (e.g. "1.2s", "350ms"). */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

type ToolCallData = TuiAssistantBlock & { readonly kind: "tool_call" };

interface ToolCallBlockProps {
  readonly block: ToolCallData;
  readonly spinnerFrame: Accessor<number>;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

/**
 * Status indicator — uses SolidJS Switch/Match for reactive status transitions.
 * Plain `switch(props.status)` runs once on mount; Switch/Match re-evaluates
 * so long-running tools progress from "running" → "complete" correctly.
 */
function StatusIndicator(props: {
  readonly status: ToolCallData["status"];
  readonly spinnerFrame: Accessor<number>;
  readonly startedAt?: number | undefined;
  readonly durationMs?: number | undefined;
}): JSX.Element {
  const frames = DEFAULT_SPINNER.frames;
  // #8: elapsed time derived from spinnerFrame tick
  const elapsed = (): string => {
    if (props.startedAt === undefined) return "";
    props.spinnerFrame(); // subscribe to tick
    const ms = Date.now() - props.startedAt;
    return ` ${formatDuration(ms)}`;
  };

  return (
    <Switch>
      <Match when={props.status === "running"}>
        <text fg={COLORS.cyan}>
          {frames[props.spinnerFrame() % frames.length] ?? " "}
          {elapsed()}
        </text>
      </Match>
      <Match when={props.status === "complete"}>
        <text fg={COLORS.success}>✓</text>
      </Match>
      <Match when={props.status === "error"}>
        <text fg={COLORS.danger}>✗</text>
      </Match>
    </Switch>
  );
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

/** Extract structured result display from ToolResultData. Only runs on completion. */
function useResultDisplay(block: ToolCallData): Accessor<ResultDisplay | null> {
  return createMemo((): ResultDisplay | null => {
    if (block.status !== "complete") return null;
    const result = block.result;
    if (result === undefined) return null;
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

  // Per-block expand state driven by expandedToolCallIds in the store (Decision 8A).
  // Ctrl+E dispatches toggle_all_tools_expanded; click dispatches expand/collapse_tool.
  const storeCtx = useContext(StoreContext);
  const isExpanded = useTuiStore((s) => s.expandedToolCallIds.has(props.block.callId));
  // #7: per-block full-body expand (show more / truncated view)
  const isBodyExpanded = useTuiStore((s) => s.expandedBodyToolCallIds.has(props.block.callId));

  // #1759: hide the elapsed-time counter on ANY running tool block while a
  // permission prompt is open. The turn-runner executes tool calls
  // sequentially (see @koi/query-engine turn-runner.ts), so while a single
  // permission prompt is blocking, the entire turn is blocked — every
  // "running" tool block in the current turn is effectively paused, waiting
  // on the user's decision. Their wall-clock elapsed counters would lie
  // about execution time if we let them keep ticking.
  //
  // A narrower per-call match (via `metadata.callId` or toolName) sounds
  // more precise, but in practice it under-hides: when the model emits
  // multiple tool calls in one turn, the first of them may have its status
  // still rendered as "running" from the UI's perspective while a later
  // call in the same batch is the one waiting on approval. The broader
  // "any pending prompt blocks all timers" rule matches the turn-runner's
  // actual serialization semantics and avoids the ticking-while-waiting
  // regression seen in manual testing.
  const isAwaitingApproval = useTuiStore(
    (s) => props.block.status === "running" && s.modal?.kind === "permission-prompt",
  );

  /** Merge arg chips and result chips for the chips row. */
  const allChips = createMemo((): readonly string[] => {
    const argChips = display()?.chips ?? [];
    const resChips = resultDisplay()?.chips ?? [];
    // #9: If no durationMs chip from result, use block.durationMs
    const hasDurationChip = resChips.some((c: string) => c.endsWith("ms") || c.endsWith("s"));
    const durationChips =
      !hasDurationChip && props.block.durationMs !== undefined
        ? [formatDuration(props.block.durationMs)]
        : [];
    if (resChips.length === 0 && durationChips.length === 0) return argChips;
    if (argChips.length === 0) return [...resChips, ...durationChips];
    return [...argChips, ...resChips, ...durationChips];
  });

  const isComplete = () => props.block.status !== "running";
  const hasBody = () => resultDisplay()?.body !== undefined && resultDisplay()?.body !== "";

  // #7: truncated body view (N lines max, with "show more" affordance)
  const truncatedBody = createMemo((): { text: string; remaining: number } | null => {
    const body = resultDisplay()?.body;
    if (!body) return null;
    const lines = body.split("\n");
    const limit = getBodyLineLimit(props.block.toolName);
    if (lines.length <= limit || isBodyExpanded()) return null;
    return {
      text: lines.slice(0, limit).join("\n"),
      remaining: lines.length - limit,
    };
  });

  return (
    <box flexDirection="column" paddingLeft={1}>
      {/* Title row: status indicator + title + subtitle (clickable for accordion) */}
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => {
          if (isComplete()) {
            if (isExpanded()) {
              storeCtx?.dispatch({ kind: "collapse_tool", callId: props.block.callId });
            } else {
              storeCtx?.dispatch({ kind: "expand_tool", callId: props.block.callId });
            }
          }
        }}
      >
        <StatusIndicator
          status={props.block.status}
          spinnerFrame={props.spinnerFrame}
          startedAt={isAwaitingApproval() ? undefined : props.block.startedAt}
          durationMs={props.block.durationMs}
        />
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

      {/* Chips row — always visible when present (#9 duration chip included) */}
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

        {/* Standard result body (non-diff) — with #7 N-line truncation */}
        <Show when={editDiff() === null && resultDisplay()?.body}>
          {(_body: Accessor<string>) => (
            <box flexDirection="column" paddingLeft={2}>
              <Show
                when={truncatedBody()}
                fallback={
                  <HighlightedText content={resultDisplay()?.body ?? ""} syntaxStyle={props.syntaxStyle} />
                }
              >
                {(t: Accessor<{ text: string; remaining: number }>) => (
                  <box flexDirection="column">
                    <HighlightedText content={t().text} syntaxStyle={props.syntaxStyle} />
                    <text
                      fg={COLORS.textMuted}
                      onMouseDown={() => {
                        storeCtx?.dispatch({ kind: "expand_tool_body", callId: props.block.callId });
                      }}
                    >
                      {`… ${t().remaining} more lines (click to expand)`}
                    </text>
                  </box>
                )}
              </Show>
            </box>
          )}
        </Show>
      </Show>
    </box>
  );
}
