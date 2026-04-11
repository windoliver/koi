/**
 * SpawnBlock — renders a spawn_call assistant block inline in the conversation.
 *
 * Shows live progress (currentTool from activeSpawns, #2) while running,
 * and completion stats when done. Clicking a completed spawn dispatches
 * set_view to the sessions view for navigating to the child session (#3).
 */

import type { Accessor, JSX } from "solid-js";
import { Show, useContext } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { StoreContext, useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";

type SpawnCallData = TuiAssistantBlock & { readonly kind: "spawn_call" };

interface SpawnBlockProps {
  readonly block: SpawnCallData;
  readonly spinnerFrame: Accessor<number>;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Format duration as human-readable string. */
function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function SpawnBlock(props: SpawnBlockProps): JSX.Element {
  const storeCtx = useContext(StoreContext);
  // #2: live progress for this agent from activeSpawns
  const liveProgress = useTuiStore((s) => s.activeSpawns.get(props.block.agentId));

  const isRunning = () => props.block.status === "running";
  const isDone = () => props.block.status === "complete";
  const isFailed = () => props.block.status === "failed";

  const statusIcon = () => {
    if (isRunning()) return SPINNER[props.spinnerFrame() % SPINNER.length] ?? "⠋";
    if (isDone()) return "✓";
    return "✗";
  };

  const statusColor = () => {
    if (isRunning()) return COLORS.cyan;
    if (isDone()) return COLORS.success;
    return COLORS.danger;
  };

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      onMouseDown={() => {
        // #3: click completed spawn → navigate to sessions view to find child session
        if (!isRunning()) {
          storeCtx?.dispatch({ kind: "set_view", view: "sessions" });
        }
      }}
    >
      {/* Header row: status icon + agent name + description */}
      <box flexDirection="row" gap={1}>
        <text fg={statusColor()}>{statusIcon()}</text>
        <text>
          <b>{props.block.agentName}</b>
          {props.block.description !== props.block.agentName ? `  ${props.block.description}` : ""}
        </text>
        {/* Completion stats chip */}
        <Show when={isDone() && props.block.stats}>
          <text fg={COLORS.textMuted}>{formatDuration(props.block.stats?.durationMs ?? 0)}</text>
        </Show>
        {/* Failed indicator */}
        <Show when={isFailed()}>
          <text fg={COLORS.danger}>{"failed"}</text>
        </Show>
      </box>

      {/* #2: live current tool activity */}
      <Show when={isRunning() && liveProgress()?.currentTool}>
        {(_: Accessor<string | undefined>) => (
          <box paddingLeft={2}>
            <text fg={COLORS.textMuted}>{liveProgress()?.currentTool}</text>
          </box>
        )}
      </Show>
    </box>
  );
}
