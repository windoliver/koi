/** Session picker view — displays saved sessions for an agent. */

import type { SelectOption } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { type Accessor, Show } from "solid-js";
import { COLORS } from "../theme.js";

/** A single saved session entry. */
export interface SessionPickerEntry {
  readonly sessionId: string;
  readonly agentName: string;
  readonly connectedAt: number;
  readonly messageCount: number;
}

/** Props for the session picker view. */
export interface SessionPickerViewProps {
  readonly sessions: Accessor<readonly SessionPickerEntry[]>;
  readonly onSelect: (sessionId: string) => void;
  readonly onCancel: () => void;
  readonly focused: boolean;
  readonly loading: Accessor<boolean>;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  return `${String(Math.round(minutes / 60))}h ago`;
}

function sessionsToOptions(sessions: readonly SessionPickerEntry[]): readonly SelectOption[] {
  return sessions.map((s) => ({
    name: s.agentName,
    description: `${formatTimeAgo(s.connectedAt)} | ${String(s.messageCount)} messages`,
    value: s.sessionId,
  }));
}

/** Session picker view with selectable session entries. */
export function SessionPickerView(props: SessionPickerViewProps): JSX.Element {
  const options = () => sessionsToOptions(props.sessions());
  const empty = (msg: string) => (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={COLORS.dim}>{msg}</text>
    </box>
  );

  return (
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}><b>{" Sessions"}</b></text>
        <text fg={COLORS.dim}>{` (${String(props.sessions().length)})`}</text>
      </box>

      <Show when={!props.loading()} fallback={empty("Loading sessions...")}>
        <Show when={props.sessions().length > 0} fallback={empty("No saved sessions")}>
          <select
            options={options() as SelectOption[]}
            focused={props.focused}
            showDescription={true}
            wrapSelection={true}
            flexGrow={1}
            selectedBackgroundColor={COLORS.blue}
            selectedTextColor={COLORS.white}
            descriptionColor={COLORS.dim}
            onSelect={(_index: number, option: SelectOption | null) => {
              if (option?.value !== undefined) {
                props.onSelect(option.value as string);
              }
            }}
          />
        </Show>
      </Show>
    </box>
  );
}
