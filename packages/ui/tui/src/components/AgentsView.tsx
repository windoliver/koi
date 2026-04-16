/**
 * AgentsView — shows active and recently-finished spawned agents (#1792).
 *
 * Accessible via /agents command (nav:agents). Reads activeSpawns and
 * finishedSpawns from the store. Active agents show live elapsed time and
 * their current sub-tool; finished agents show final duration and outcome
 * (complete / failed). Keeps the last MAX_FINISHED_SPAWNS per session so
 * short-lived children remain visible after completion.
 */

import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTuiStore } from "../store-context.js";
import type { SpawnRecord } from "../state/types.js";
import { COLORS } from "../theme.js";

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function AgentsView(): JSX.Element {
  const activeSpawns = useTuiStore((s) => s.activeSpawns);
  const finishedSpawns = useTuiStore((s) => s.finishedSpawns);

  const active = createMemo(() => Array.from(activeSpawns().entries()));
  const finished = createMemo(() => finishedSpawns());
  const hasAny = createMemo(() => active().length > 0 || finished().length > 0);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.purple}>
        <b>{"Agents"}</b>
      </text>
      <text fg={COLORS.textMuted}>{"Esc or q to go back"}</text>

      <Show
        when={hasAny()}
        fallback={
          <box paddingTop={1}>
            <text fg={COLORS.textMuted}>{"No agents spawned yet."}</text>
          </box>
        }
      >
        <Show when={active().length > 0}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={COLORS.textSecondary}>
              <b>{`Active (${active().length})`}</b>
            </text>
            <box flexDirection="column" paddingTop={1} gap={1}>
              <For each={active()}>
                {([agentId, progress]) => {
                  const elapsed = formatDuration(Date.now() - progress.startedAt);
                  return (
                    <box flexDirection="column" paddingLeft={1}>
                      <box flexDirection="row" gap={1}>
                        <text fg={COLORS.cyan}>{"⠋"}</text>
                        <text>
                          <b>{progress.agentName}</b>
                        </text>
                        <text fg={COLORS.textMuted}>{elapsed}</text>
                      </box>
                      <box paddingLeft={2}>
                        <text fg={COLORS.textSecondary}>{progress.description}</text>
                      </box>
                      <Show when={progress.currentTool}>
                        <box paddingLeft={2}>
                          <text fg={COLORS.textMuted}>{`→ ${progress.currentTool}`}</text>
                        </box>
                      </Show>
                      <box paddingLeft={2}>
                        <text fg={COLORS.fgDim}>{agentId}</text>
                      </box>
                    </box>
                  );
                }}
              </For>
            </box>
          </box>
        </Show>

        <Show when={finished().length > 0}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={COLORS.textSecondary}>
              <b>{`Recent (${finished().length})`}</b>
            </text>
            <box flexDirection="column" paddingTop={1}>
              <For each={finished()}>
                {(rec: SpawnRecord) => {
                  const badge = rec.outcome === "complete" ? "✓" : "✗";
                  const badgeColor = rec.outcome === "complete" ? COLORS.green : COLORS.red;
                  const duration = formatDuration(rec.durationMs);
                  return (
                    <box flexDirection="column" paddingLeft={1}>
                      <box flexDirection="row" gap={1}>
                        <text fg={badgeColor}>{badge}</text>
                        <text>
                          <b>{rec.agentName}</b>
                        </text>
                        <text fg={COLORS.textMuted}>{duration}</text>
                      </box>
                      <box paddingLeft={2}>
                        <text fg={COLORS.textSecondary}>{rec.description}</text>
                      </box>
                      <box paddingLeft={2}>
                        <text fg={COLORS.fgDim}>{rec.agentId}</text>
                      </box>
                    </box>
                  );
                }}
              </For>
            </box>
          </box>
        </Show>
      </Show>
    </box>
  );
}
