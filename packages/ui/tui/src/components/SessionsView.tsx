/**
 * SessionsView — "sessions" screen (activeView === "sessions").
 *
 * Lists saved sessions from state.sessions. Read-only — use the session picker
 * modal (Ctrl+P → "Resume session") to actually resume a session.
 */

import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";

export function SessionsView(): JSX.Element {
  const sessions = useTuiStore((s) => s.sessions);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.cyan}>{"Sessions"}</text>
      <text>{" "}</text>
      <Show
        when={sessions().length > 0}
        fallback={
          <text fg={COLORS.dim}>
            {"No saved sessions yet. Complete a conversation to create one."}
          </text>
        }
      >
        <For each={sessions()}>
          {(session) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={COLORS.white}>{session.name}</text>
              <text fg={COLORS.dim}>{`${session.messageCount} messages · ${session.preview}`}</text>
            </box>
          )}
        </For>
      </Show>
      <text>{" "}</text>
      <text fg={COLORS.fgDim}>{"Ctrl+P → Resume session  ·  Esc → back"}</text>
    </box>
  );
}
