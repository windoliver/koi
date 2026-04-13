/**
 * TrajectoryView — interactive ATIF trajectory viewer (activeView === "trajectory").
 *
 * Features:
 *   - Steps grouped by turn (Turn 0 = session setup, Turn 1+ = user turns)
 *   - Arrow keys navigate items (turn headers + step rows), Enter toggles expand/collapse
 *   - Turn headers collapse/expand all steps in that turn
 *   - Expanded steps show request/response with JSON syntax highlighting
 *   - Token metrics shown for model steps; turn header aggregates across all steps
 *   - Color-coded outcomes (✓ green, ✗ red, ↻ yellow)
 *   - Scrollable list using createScrollableList primitive
 *   - New turns auto-expand as they appear during live sessions
 *
 * Data is injected by the host via set_trajectory_data action.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { LedgerAuditEntry, LedgerSources, TrajectoryStepSummary } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { createScrollableList } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ITEMS = 16;
const MAX_CONTENT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Turn grouping types
// ---------------------------------------------------------------------------

interface TurnGroup {
  readonly turnIndex: number;
  readonly steps: readonly TrajectoryStepSummary[];
}

interface TurnSummary {
  readonly turnIndex: number;
  readonly label: string;
  readonly stepCount: number;
  readonly durationMs: number | undefined;
  readonly tokensIn: number | undefined;
  readonly tokensOut: number | undefined;
  readonly hasFailure: boolean;
}

type FlatItem =
  | { readonly kind: "turn_header"; readonly summary: TurnSummary }
  | { readonly kind: "step"; readonly step: TrajectoryStepSummary };

// ---------------------------------------------------------------------------
// Turn grouping helpers
// ---------------------------------------------------------------------------

function groupByTurn(steps: readonly TrajectoryStepSummary[]): readonly TurnGroup[] {
  const map = new Map<number, TrajectoryStepSummary[]>();
  for (const step of steps) {
    const bucket = map.get(step.turnIndex) ?? [];
    bucket.push(step);
    map.set(step.turnIndex, bucket);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([turnIndex, groupSteps]) => ({ turnIndex, steps: groupSteps }));
}

function computeTurnSummary(group: TurnGroup): TurnSummary {
  let totalMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let hasTokens = false;
  let hasFailure = false;
  for (const step of group.steps) {
    if (step.durationMs !== undefined) totalMs += step.durationMs;
    if (step.tokens?.promptTokens !== undefined) { tokensIn += step.tokens.promptTokens; hasTokens = true; }
    if (step.tokens?.completionTokens !== undefined) { tokensOut += step.tokens.completionTokens; hasTokens = true; }
    if (step.outcome === "failure") hasFailure = true;
  }
  const label = group.turnIndex === 0 ? "Setup" : `Turn ${group.turnIndex}`;
  return {
    turnIndex: group.turnIndex,
    label,
    stepCount: group.steps.length,
    durationMs: totalMs > 0 ? totalMs : undefined,
    tokensIn: hasTokens ? tokensIn : undefined,
    tokensOut: hasTokens ? tokensOut : undefined,
    hasFailure,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "  —";
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${String(rounded).padStart(4)}ms`;
  return `${(rounded / 1000).toFixed(1).padStart(5)}s`;
}

function outcomeColor(outcome: string | undefined): string {
  if (outcome === "success") return COLORS.green;
  if (outcome === "failure") return COLORS.red;
  if (outcome === "retry") return COLORS.yellow;
  return COLORS.dim;
}

function outcomeSymbol(outcome: string | undefined): string {
  if (outcome === "success") return "✓";
  if (outcome === "failure") return "✗";
  if (outcome === "retry") return "↻";
  return "·";
}

function kindLabel(kind: string): string {
  if (kind === "model_call") return "model";
  if (kind === "tool_call") return "tool ";
  return kind.slice(0, 5).padEnd(5);
}

function kindColor(kind: string): string {
  if (kind === "model_call") return COLORS.blue;
  if (kind === "tool_call") return COLORS.cyan;
  return COLORS.dim;
}

function formatTokens(step: TrajectoryStepSummary): string | undefined {
  if (step.tokens === undefined) return undefined;
  const parts: string[] = [];
  if (step.tokens.promptTokens !== undefined) parts.push(`in:${step.tokens.promptTokens}`);
  if (step.tokens.completionTokens !== undefined) parts.push(`out:${step.tokens.completionTokens}`);
  if (step.tokens.cachedTokens !== undefined && step.tokens.cachedTokens > 0) {
    parts.push(`cached:${step.tokens.cachedTokens}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Summarize the first decision into a compact suffix label. */
function summarizeDecision(d: Record<string, unknown>): string | undefined {
  // Permissions MW — filter phase
  if (d.phase === "filter" && typeof d.allowedCount === "number" && typeof d.totalTools === "number") {
    return `filter:${d.allowedCount}/${d.totalTools}`;
  }
  // Permissions MW — execute phase
  if (d.phase === "execute" && typeof d.action === "string") {
    const label = String(d.action);
    return d.toolId !== undefined ? `${label}:${String(d.toolId)}` : label;
  }
  // Exfiltration guard — clean or match
  if (typeof d.location === "string" && typeof d.action === "string") {
    return d.matchCount !== undefined ? `${String(d.action)}:${String(d.matchCount)}` : String(d.action);
  }
  // Hooks MW — with or without hooks fired
  if (typeof d.event === "string" && typeof d.aggregated === "string") {
    if (d.hooksFired === 0) return "0 hooks";
    return String(d.aggregated);
  }
  // Semantic retry — pass, rewrite, or abort
  if (d.action === "pass" && typeof d.budgetRemaining === "number") {
    return `pass:${d.budgetRemaining}`;
  }
  if (typeof d.action === "string" && (d.action === "rewrite" || d.action === "abort")) {
    return d.rewriteKind !== undefined ? `${String(d.action)}:${String(d.rewriteKind)}` : String(d.action);
  }
  // Rules MW — injection
  if (d.action === "inject" && typeof d.files === "number") {
    return `inject:${d.files} files ${String(d.estimatedTokens ?? "")}tok`;
  }
  // System prompt MW — injection
  if (d.action === "inject" && typeof d.promptLength === "number") {
    return `inject:${d.promptLength}ch`;
  }
  // Session transcript — record
  if (d.action === "record") {
    return d.toolId !== undefined ? `record:${String(d.toolId)}` : `record:${String(d.entries ?? 0)}`;
  }
  // Checkpoint — capture
  if (d.action === "capture") {
    return d.captured === true ? `capture:${String(d.path ?? "")}` : "skip";
  }
  return undefined;
}

function formatMwSpanSuffix(step: TrajectoryStepSummary): string | undefined {
  if (step.middlewareSpan === undefined) return undefined;
  const { decisions, nextCalled, hook } = step.middlewareSpan;
  // Prefer decision summary over hook name
  if (decisions !== undefined && decisions.length > 0) {
    const first = decisions[0];
    if (first !== undefined) {
      const summary = summarizeDecision(first as Record<string, unknown>);
      if (summary !== undefined) {
        const extra = decisions.length > 1 ? ` +${decisions.length - 1}` : "";
        return nextCalled === false ? `${summary} BLOCKED${extra}` : `${summary}${extra}`;
      }
    }
  }
  // Fallback: "pass" for no-op hooks, "BLOCKED" if chain stopped
  if (nextCalled === false) return "BLOCKED";
  return "pass";
}

/** Format a single decision object as a one-line key-value summary. */
function formatDecisionLine(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

function truncateContent(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? text.slice(0, MAX_CONTENT_CHARS) + `\n… (${text.length - MAX_CONTENT_CHARS} chars truncated)`
    : text;
}

function formatTurnMeta(summary: TurnSummary): string {
  const parts: string[] = [`${summary.stepCount} step${summary.stepCount === 1 ? "" : "s"}`];
  if (summary.durationMs !== undefined) parts.push(formatDuration(summary.durationMs).trim());
  if (summary.tokensIn !== undefined) parts.push(`in:${summary.tokensIn}`);
  if (summary.tokensOut !== undefined) parts.push(`out:${summary.tokensOut}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TurnHeaderRow(props: {
  readonly summary: TurnSummary;
  readonly isSelected: () => boolean;
  readonly isExpanded: () => boolean;
}): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.isSelected() ? COLORS.yellow : COLORS.dim}>
        {props.isSelected() ? "▶" : " "}
      </text>
      <text fg={props.isSelected() ? COLORS.yellow : COLORS.white}>
        {props.isExpanded() ? "▼" : "▶"}
      </text>
      <text fg={props.isSelected() ? COLORS.white : COLORS.cyan}>
        {props.summary.label.padEnd(8)}
      </text>
      <text fg={props.summary.hasFailure ? COLORS.red : COLORS.dim}>
        {formatTurnMeta(props.summary)}
      </text>
    </box>
  );
}

function StepRow(props: {
  readonly step: TrajectoryStepSummary;
  readonly isSelected: () => boolean;
  readonly isExpanded: () => boolean;
}): JSX.Element {
  return (
    <box flexDirection="column" paddingLeft={2}>
      {/* Step summary row */}
      <box flexDirection="row" gap={1}>
        <text fg={props.isSelected() ? COLORS.yellow : COLORS.dim}>
          {props.isSelected() ? "▶" : " "}
        </text>
        <text fg={COLORS.dim}>{String(props.step.stepIndex + 1).padStart(3)}</text>
        <text fg={outcomeColor(props.step.outcome)}>{outcomeSymbol(props.step.outcome)}</text>
        <text fg={kindColor(props.step.kind)}>{kindLabel(props.step.kind)}</text>
        <text fg={props.isSelected() ? COLORS.white : COLORS.dim}>
          {props.step.identifier.slice(0, 36).padEnd(36)}
        </text>
        <text fg={COLORS.dim}>{formatDuration(props.step.durationMs)}</text>
        <Show when={formatTokens(props.step)}>
          {(tok: () => string) => <text fg={COLORS.dim}>{` ${tok()}`}</text>}
        </Show>
        <Show when={formatMwSpanSuffix(props.step)}>
          {(mw: () => string) => <text fg={COLORS.dim}>{` [${mw()}]`}</text>}
        </Show>
      </box>

      {/* Expanded detail */}
      <Show when={props.isExpanded()}>
        <box flexDirection="column" paddingLeft={6} paddingBottom={1}>
          <Show when={props.step.requestText !== undefined && props.step.requestText !== ""}>
            <text fg={COLORS.dim}>{"─ request:"}</text>
            <box paddingLeft={2}>
              <text fg={COLORS.white}>{truncateContent(props.step.requestText ?? "")}</text>
            </box>
          </Show>
          <Show when={props.step.responseText !== undefined && props.step.responseText !== ""}>
            <text fg={COLORS.dim}>{"─ response:"}</text>
            <box paddingLeft={2}>
              <text fg={COLORS.white}>{truncateContent(props.step.responseText ?? "")}</text>
            </box>
          </Show>
          <Show when={props.step.errorText !== undefined && props.step.errorText !== ""}>
            <text fg={COLORS.red}>{"─ error:"}</text>
            <box paddingLeft={2}>
              <text fg={COLORS.red}>{truncateContent(props.step.errorText ?? "")}</text>
            </box>
          </Show>

          {/* MW Decisions */}
          <Show
            when={
              props.step.middlewareSpan?.decisions !== undefined
              && props.step.middlewareSpan.decisions.length > 0
            }
          >
            <text fg={COLORS.dim}>{"─ decisions:"}</text>
            <box paddingLeft={2} flexDirection="column">
              <For each={props.step.middlewareSpan?.decisions ?? []}>
                {(d, i) => (
                  <text fg={COLORS.white}>
                    {`[${i()}] ${formatDecisionLine(d as Record<string, unknown>)}`}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function formatSourceStatus(label: string, status: string): string {
  if (status === "present" || status === "present-unverified") return `${label}:ok`;
  if (status === "present-with-leakage") return `${label}:leak`;
  if (status === "missing") return `${label}:—`;
  if (status === "unqueryable") return `${label}:n/a`;
  return `${label}:${status}`;
}

function sourceColor(status: string): string {
  if (status === "present" || status === "present-unverified") return COLORS.green;
  if (status === "missing" || status === "unqueryable") return COLORS.dim;
  return COLORS.yellow;
}

function formatAuditEntry(entry: LedgerAuditEntry): string {
  const ts = new Date(entry.timestamp).toISOString().slice(11, 19);
  return `${ts} [${entry.kind}] ${entry.summary}`;
}

export function TrajectoryView(): JSX.Element {
  const steps = useTuiStore((s) => s.trajectorySteps);
  const auditEntries = useTuiStore((s) => s.auditEntries);
  const ledgerSources = useTuiStore((s) => s.ledgerSources);
  const runReportSummary = useTuiStore((s) => s.runReportSummary);

  const turns = createMemo(() => groupByTurn(steps()));

  const [expandedTurns, setExpandedTurns] = createSignal<ReadonlySet<number>>(new Set<number>());
  const [expandedStepIdx, setExpandedStepIdx] = createSignal<number | null>(null);

  // Auto-expand each new turn as it appears during a live session.
  createEffect(
    on(turns, (current, prev) => {
      if (current.length === 0) return;
      const lastTurn = current[current.length - 1];
      if (lastTurn === undefined) return;
      const prevIndices = new Set((prev ?? []).map((t) => t.turnIndex));
      if (!prevIndices.has(lastTurn.turnIndex)) {
        setExpandedTurns((s) => new Set([...s, lastTurn.turnIndex]));
      }
    }),
  );

  // Flat list: turn headers interleaved with step rows for expanded turns.
  // Synthetic koi:tui_turn_start boundary steps are hidden — they're bookkeeping only.
  const flatItems = createMemo((): readonly FlatItem[] => {
    const result: FlatItem[] = [];
    for (const group of turns()) {
      const visibleSteps = group.steps.filter((s) => s.identifier !== "koi:tui_turn_start");
      result.push({ kind: "turn_header", summary: computeTurnSummary({ ...group, steps: visibleSteps }) });
      if (expandedTurns().has(group.turnIndex)) {
        for (const step of visibleSteps) {
          result.push({ kind: "step", step });
        }
      }
    }
    return result;
  });

  const list = createScrollableList(flatItems, MAX_VISIBLE_ITEMS);

  useKeyboard((key: KeyEvent) => {
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      list.moveUp();
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      list.moveDown();
    } else if (key.name === "return") {
      const item = flatItems()[list.selectedIdx()];
      if (item === undefined) return;
      if (item.kind === "turn_header") {
        const ti = item.summary.turnIndex;
        setExpandedTurns((s) => {
          const next = new Set(s);
          if (next.has(ti)) { next.delete(ti); } else { next.add(ti); }
          return next;
        });
        setExpandedStepIdx(null);
      } else {
        const si = item.step.stepIndex;
        setExpandedStepIdx((prev) => (prev === si ? null : si));
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>
        <b>{"Session Trajectory"}</b>
      </text>
      <text fg={COLORS.dim}>{"↑↓ navigate · Enter expand/collapse turn or step · Esc return"}</text>
      <text>{" "}</text>

      <Show
        when={steps().length > 0}
        fallback={
          <text fg={COLORS.dim}>
            {"No trajectory steps recorded yet. Submit a prompt to start recording."}
          </text>
        }
      >
        <For each={list.visibleItems()}>
          {(item, localIdx) => {
            const globalIdx = (): number => list.visibleStart() + localIdx();
            const isSelected = (): boolean => globalIdx() === list.selectedIdx();

            if (item.kind === "turn_header") {
              return (
                <TurnHeaderRow
                  summary={item.summary}
                  isSelected={isSelected}
                  isExpanded={() => expandedTurns().has(item.summary.turnIndex)}
                />
              );
            }
            return (
              <StepRow
                step={item.step}
                isSelected={isSelected}
                isExpanded={() => expandedStepIdx() === item.step.stepIndex}
              />
            );
          }}
        </For>

        <text>{" "}</text>
        <text fg={COLORS.dim}>
          {`${turns().length} turn${turns().length === 1 ? "" : "s"} · `
            + `${steps().length} step${steps().length === 1 ? "" : "s"} · `
            + `${steps().filter((s) => s.kind === "model_call").length} model · `
            + `${steps().filter((s) => s.kind === "tool_call").length} tool`}
        </text>

        {/* Ledger source status */}
        <Show when={ledgerSources() !== null}>
          {(_src: () => unknown) => {
            const src = ledgerSources() as LedgerSources;
            return (
              <text fg={COLORS.dim}>
                {`  sources: `}
                <text fg={sourceColor(src.trajectory)}>
                  {formatSourceStatus("trajectory", src.trajectory)}
                </text>
                {` · `}
                <text fg={sourceColor(src.audit)}>
                  {formatSourceStatus("audit", src.audit)}
                </text>
                {` · `}
                <text fg={sourceColor(src.report)}>
                  {formatSourceStatus("report", src.report)}
                </text>
              </text>
            );
          }}
        </Show>

        {/* Audit entries */}
        <Show when={auditEntries().length > 0}>
          <text>{" "}</text>
          <text fg={COLORS.cyan}>
            <b>{`Audit Entries (${auditEntries().length})`}</b>
          </text>
          <For each={auditEntries().slice(0, 20)}>
            {(entry) => (
              <text fg={COLORS.dim}>{`  ${formatAuditEntry(entry)}`}</text>
            )}
          </For>
          <Show when={auditEntries().length > 20}>
            <text fg={COLORS.dim}>{`  … ${auditEntries().length - 20} more`}</text>
          </Show>
        </Show>

        {/* Run report */}
        <Show when={runReportSummary() !== null}>
          <text>{" "}</text>
          <text fg={COLORS.cyan}>
            <b>{"Run Report"}</b>
          </text>
          <text fg={COLORS.dim}>{`  ${runReportSummary()}`}</text>
        </Show>
      </Show>
    </box>
  );
}
