/**
 * AgentsView — shows active and recently-finished spawned agents (#1792) plus
 * any manifest-declared supervised children (#1866).
 *
 * Accessible via /agents command (nav:agents). Reads activeSpawns and
 * finishedSpawns from the store for ad-hoc user-triggered spawns, and
 * supervisedChildren for children declared via manifest.supervision. Active
 * agents show live elapsed time and their current sub-tool; finished agents
 * show final duration and outcome (complete / failed).
 */

import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTuiStore } from "../store-context.js";
import type { SpawnRecord, SupervisedChildEntry } from "../state/types.js";
import { COLORS } from "../theme.js";

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * One-line description. The renderer's flex-column layout doesn't reserve
 * vertical space for soft-wrapped text, so a 2+ line description gets
 * clobbered by the agentId row below it. Collapse newlines and truncate.
 */
const DESCRIPTION_MAX_CHARS = 200;
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_MAX_CHARS
    ? `${flat.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`
    : flat;
}

function phaseColor(phase: SupervisedChildEntry["phase"]): string {
  switch (phase) {
    case "running":
      return COLORS.green;
    case "terminated":
      return COLORS.red;
    case "created":
    case "waiting":
    case "suspended":
    case "idle":
      return COLORS.textMuted;
  }
}

export function AgentsView(): JSX.Element {
  const activeSpawns = useTuiStore((s) => s.activeSpawns);
  const finishedSpawns = useTuiStore((s) => s.finishedSpawns);
  const supervisedChildren = useTuiStore((s) => s.supervisedChildren);

  const active = createMemo(() => Array.from(activeSpawns().entries()));
  const finished = createMemo(() => finishedSpawns());
  const supervised = createMemo(() => supervisedChildren());
  const hasAny = createMemo(
    () => active().length > 0 || finished().length > 0 || supervised().length > 0,
  );

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
        <Show when={supervised().length > 0}>
          <box flexDirection="column" paddingTop={1}>
            <text fg={COLORS.textSecondary}>
              <b>{`Supervised (${supervised().length})`}</b>
            </text>
            <box flexDirection="column" paddingTop={1}>
              <For each={supervised()}>
                {(child: SupervisedChildEntry) => (
                  <box flexDirection="column" paddingLeft={1}>
                    <box flexDirection="row" gap={1}>
                      <text fg={phaseColor(child.phase)}>{"●"}</text>
                      <text>
                        <b>{child.childSpecName}</b>
                      </text>
                      <text fg={COLORS.textMuted}>{child.phase}</text>
                    </box>
                    <box paddingLeft={2}>
                      <text fg={COLORS.fgDim}>{child.agentId}</text>
                    </box>
                  </box>
                )}
              </For>
            </box>
          </box>
        </Show>

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
                        <text fg={COLORS.textSecondary}>{oneLine(progress.description)}</text>
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
                        <text fg={COLORS.textSecondary}>{oneLine(rec.description)}</text>
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
