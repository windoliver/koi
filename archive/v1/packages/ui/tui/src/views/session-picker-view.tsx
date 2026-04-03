/** Session picker view — displays saved sessions for an agent. */

import type { SelectOption } from "@opentui/core";
import { useMemo } from "react";
import { PanelChrome } from "../components/panel-chrome.js";
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
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  return `${String(Math.round(minutes / 60))}h ago`;
}

function sessionsToOptions(sessions: readonly SessionPickerEntry[]): readonly SelectOption[] {
  return sessions.map((s) => {
    const parts = [`${formatTimeAgo(s.connectedAt)} | ${String(s.messageCount)} msgs`];
    if (s.preview !== "") {
      parts.push(`"${s.preview}"`);
    }
    return {
      name: s.agentName,
      description: parts.join("  "),
      value: s.sessionId,
    };
  });
}

/** Session picker view with selectable session entries. */
export function SessionPickerView(props: SessionPickerViewProps): React.ReactNode {
  const options = useMemo(() => sessionsToOptions(props.sessions), [props.sessions]);

  return (
    <PanelChrome
      title="Sessions"
      count={props.sessions.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={props.loading}
      loadingMessage="Loading sessions..."
      isEmpty={props.sessions.length === 0}
      emptyMessage="No saved sessions yet."
      emptyHint="Chat with an agent — sessions save automatically."
    >
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
    </PanelChrome>
  );
}
