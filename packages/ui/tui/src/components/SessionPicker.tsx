/**
 * SessionPicker — overlay for browsing and resuming saved sessions.
 *
 * Data injected via set_session_list action (already sorted most-recent-first,
 * capped at MAX_SESSIONS by the reducer). No I/O in this component.
 * Uses SelectOverlay for list rendering + keyboard navigation.
 */

import type { JSX } from "solid-js";
import { useTuiStore } from "../store-context.js";
import type { SessionSummary } from "../state/types.js";
import { COLORS, MODAL_POSITION } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";
import { formatSessionDate, getSessionDescription } from "./session-picker-helpers.js";

export { formatSessionDate, getSessionDescription };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionPickerProps {
  /** Called when the user selects a session to resume. */
  readonly onSelect: (session: SessionSummary) => void;
  /** Called when the user dismisses (Escape). */
  readonly onClose: () => void;
  /** Whether this overlay has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Label extractor
// ---------------------------------------------------------------------------

const getSessionLabel = (s: SessionSummary): string => s.name;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionPicker(props: SessionPickerProps): JSX.Element {
  const sessions = useTuiStore((s) => s.sessions);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.purple}
      width={70}
      {...MODAL_POSITION}
    >
      {/* Header */}
      <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.purple}>
          <b>{"Sessions"}</b>
        </text>
        <text fg={COLORS.textMuted}>{" — select to resume, Esc to cancel"}</text>
      </box>

      {/* Session list */}
      <SelectOverlay
        items={sessions()}
        getLabel={getSessionLabel}
        getDescription={getSessionDescription}
        onSelect={props.onSelect}
        onClose={props.onClose}
        focused={props.focused}
        emptyText="No saved sessions yet"
      />
    </box>
  );
}
