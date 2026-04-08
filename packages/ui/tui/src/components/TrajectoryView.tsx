/**
 * TrajectoryView — interactive ATIF trajectory viewer (activeView === "trajectory").
 *
 * Features:
 *   - Arrow keys navigate steps, Enter toggles expand/collapse
 *   - Expanded steps show request/response with JSON syntax highlighting
 *   - Token metrics shown for model steps
 *   - Color-coded outcomes (✓ green, ✗ red, ↻ yellow)
 *   - Scrollable list using createScrollableList primitive
 *
 * Data is injected by the host via set_trajectory_data action.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { TrajectoryStepSummary } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { createScrollableList } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE_STEPS = 16;
const MAX_CONTENT_CHARS = 2000;

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

function formatMwSpanSuffix(step: TrajectoryStepSummary): string | undefined {
  if (step.middlewareSpan === undefined) return undefined;
  const parts: string[] = [];
  if (step.middlewareSpan.hook !== undefined) {
    const short = step.middlewareSpan.hook.replace("wrap", "").replace("Call", "");
    parts.push(short);
  }
  if (step.middlewareSpan.nextCalled === false) parts.push("BLOCKED");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function truncateContent(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? text.slice(0, MAX_CONTENT_CHARS) + `\n… (${text.length - MAX_CONTENT_CHARS} chars truncated)`
    : text;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TrajectoryView(): JSX.Element {
  const steps = useTuiStore((s) => s.trajectorySteps);
  const list = createScrollableList(steps, MAX_VISIBLE_STEPS);
  const [expandedIdx, setExpandedIdx] = createSignal<number | null>(null);

  useKeyboard((key: KeyEvent) => {
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      list.moveUp();
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      list.moveDown();
    } else if (key.name === "return") {
      const idx = list.selectedIdx();
      setExpandedIdx(expandedIdx() === idx ? null : idx);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>
        <b>{"Session Trajectory"}</b>
      </text>
      <text fg={COLORS.dim}>{"↑↓ navigate · Enter expand/collapse · Esc return"}</text>
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
          {(step, localIdx) => {
            const globalIdx = (): number => list.visibleStart() + localIdx();
            const isSelected = (): boolean => globalIdx() === list.selectedIdx();
            const isExpanded = (): boolean => globalIdx() === expandedIdx();

            return (
              <box flexDirection="column">
                {/* Step row */}
                <box flexDirection="row" gap={1}>
                  <text fg={isSelected() ? COLORS.yellow : COLORS.dim}>
                    {isSelected() ? "▶" : " "}
                  </text>
                  <text fg={COLORS.dim}>{String(globalIdx() + 1).padStart(3)}</text>
                  <text fg={outcomeColor(step.outcome)}>{outcomeSymbol(step.outcome)}</text>
                  <text fg={kindColor(step.kind)}>{kindLabel(step.kind)}</text>
                  <text fg={isSelected() ? COLORS.white : COLORS.dim}>
                    {step.identifier.slice(0, 36).padEnd(36)}
                  </text>
                  <text fg={COLORS.dim}>{formatDuration(step.durationMs)}</text>
                  <Show when={formatTokens(step)}>
                    {(tok: () => string) => <text fg={COLORS.dim}>{` ${tok()}`}</text>}
                  </Show>
                  <Show when={formatMwSpanSuffix(step)}>
                    {(mw: () => string) => <text fg={COLORS.dim}>{` [${mw()}]`}</text>}
                  </Show>
                </box>

                {/* Expanded detail */}
                <Show when={isExpanded()}>
                  <box flexDirection="column" paddingLeft={6} paddingBottom={1}>
                    {/* Request */}
                    <Show when={step.requestText !== undefined && step.requestText !== ""}>
                      <text fg={COLORS.dim}>{"─ request:"}</text>
                      <box paddingLeft={2}>
                        <text fg={COLORS.white}>
                          {truncateContent(step.requestText ?? "")}
                        </text>
                      </box>
                    </Show>

                    {/* Response */}
                    <Show when={step.responseText !== undefined && step.responseText !== ""}>
                      <text fg={COLORS.dim}>{"─ response:"}</text>
                      <box paddingLeft={2}>
                        <text fg={COLORS.white}>
                          {truncateContent(step.responseText ?? "")}
                        </text>
                      </box>
                    </Show>

                    {/* Error */}
                    <Show when={step.errorText !== undefined && step.errorText !== ""}>
                      <text fg={COLORS.red}>{"─ error:"}</text>
                      <box paddingLeft={2}>
                        <text fg={COLORS.red}>{truncateContent(step.errorText ?? "")}</text>
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            );
          }}
        </For>

        <text>{" "}</text>
        <text fg={COLORS.dim}>
          {`${steps().length} step${steps().length === 1 ? "" : "s"} · `
            + `${steps().filter((s) => s.kind === "model_call").length} model · `
            + `${steps().filter((s) => s.kind === "tool_call").length} tool`}
        </text>
      </Show>
    </box>
  );
}
