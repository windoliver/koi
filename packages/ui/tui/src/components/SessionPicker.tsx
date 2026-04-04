/**
 * SessionPicker — overlay for browsing and resuming saved sessions.
 *
 * Data injected via set_session_list action (already sorted most-recent-first,
 * capped at MAX_SESSIONS by the reducer). No I/O in this component.
 * Uses SelectOverlay for list rendering + keyboard navigation.
 */

import React, { memo, useCallback } from "react";
import { useTuiStore } from "../store-context.js";
import type { SessionSummary } from "../state/types.js";
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

export const SessionPicker: React.NamedExoticComponent<SessionPickerProps> = memo(
  function SessionPicker(props: SessionPickerProps): React.ReactNode {
    const { onSelect, onClose, focused } = props;

    const sessions = useTuiStore((s) => s.sessions);

    const handleSelect = useCallback(
      (session: SessionSummary) => {
        onSelect(session);
      },
      [onSelect],
    );

    return (
      <box
        flexDirection="column"
        border={true}
        borderColor="#A78BFA"
        width={70}
        position="absolute"
        top={1}
        left={2}
        zIndex={20}
      >
        {/* Header */}
        <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
          <text fg="#A78BFA">
            <b>{"Sessions"}</b>
          </text>
          <text fg="#64748B">{" — select to resume, Esc to cancel"}</text>
        </box>

        {/* Session list */}
        <SelectOverlay
          items={sessions}
          getLabel={getSessionLabel}
          getDescription={getSessionDescription}
          onSelect={handleSelect}
          onClose={onClose}
          focused={focused}
          emptyText="No saved sessions yet"
        />
      </box>
    );
  },
);
