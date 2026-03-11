/** Session picker view — displays saved sessions for an agent. */

import type { SelectOption } from "@opentui/core";
import { useMemo } from "react";
import type { SessionPickerEntry } from "../state/types.js";
import { COLORS } from "../theme.js";

export type { SessionPickerEntry } from "../state/types.js";

/** Props for the session picker view. */
export interface SessionPickerViewProps {
  readonly sessions: readonly SessionPickerEntry[];
  readonly onSelect: (sessionId: string) => void;
  readonly onCancel: () => void;
  readonly focused: boolean;
  readonly loading: boolean;
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
export function SessionPickerView(props: SessionPickerViewProps): React.ReactNode {
  const options = useMemo(() => sessionsToOptions(props.sessions), [props.sessions]);

  const empty = (msg: string): React.ReactNode => (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={COLORS.dim}>{msg}</text>
    </box>
  );

  return (
    <box flexGrow={1} flexDirection="column">
      <box height={1} flexDirection="row">
        <text fg={COLORS.cyan}><b>{" Sessions"}</b></text>
        <text fg={COLORS.dim}>{` (${String(props.sessions.length)})`}</text>
      </box>

      {props.loading ? (
        empty("Loading sessions...")
      ) : props.sessions.length > 0 ? (
        <select
          options={options as SelectOption[]}
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
      ) : (
        empty("No saved sessions")
      )}
    </box>
  );
}
