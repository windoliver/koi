/**
 * AgentsView — shows all actively running spawned agents as a list (#5).
 *
 * Accessible via /agents command (nav:agents). Reads activeSpawns from store.
 * Shows agentId, agentName, description, and elapsed time for each live agent.
 */

import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";

export function AgentsView(): JSX.Element {
  const activeSpawns = useTuiStore((s) => s.activeSpawns);
  const now = Date.now();

  const agents = createMemo(() => Array.from(activeSpawns().entries()));

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.purple}>
        <b>{"Active Agents"}</b>
      </text>
      <text fg={COLORS.textMuted}>{"Esc or q to go back"}</text>

      <Show
        when={agents().length > 0}
        fallback={
          <box paddingTop={1}>
            <text fg={COLORS.textMuted}>{"No active agents."}</text>
          </box>
        }
      >
        <box flexDirection="column" paddingTop={1} gap={1}>
          <For each={agents()}>
            {([agentId, progress]) => {
              const elapsedMs = now - progress.startedAt;
              const elapsed =
                elapsedMs >= 1000
                  ? `${(elapsedMs / 1000).toFixed(1)}s`
                  : `${elapsedMs}ms`;

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
      </Show>
    </box>
  );
}
