/**
 * SessionPicker — overlay for browsing and resuming saved sessions.
 *
 * Data injected via set_session_list action (already sorted most-recent-first,
 * capped at MAX_SESSIONS by the reducer). No I/O in this component.
 * Uses SelectOverlay for list rendering + keyboard navigation.
 *
 * Space toggles a peek panel showing the full session preview without
 * the 40-character truncation applied in the list description.
 */

import type { JSX } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";
import { useTuiStore } from "../store-context.js";
import type { SessionSummary } from "../state/types.js";
import { COLORS, MODAL_POSITION } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";
import {
  formatSessionDate,
  getSessionDescription,
  getSessionPeekLines,
} from "./session-picker-helpers.js";

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
  // peekActive: whether peek mode is on.
  // peekedId: ID of the session the peek panel follows — store ID, not the snapshot,
  // so the panel re-derives from sessions() when the list is refreshed.
  const [peekActive, setPeekActive] = createSignal(false);
  const [peekedId, setPeekedId] = createSignal<string | null>(null);

  // Derive the live session data from the current list so stale snapshots are impossible.
  const peekedSession = createMemo((): SessionSummary | null => {
    const id = peekedId();
    if (id === null) return null;
    return sessions().find((s) => s.id === id) ?? null;
  });

  // peekedId is always current — SelectOverlay fires onNavigate via createEffect
  // whenever selectedIdx changes (keyboard or list refresh).
  const handlePeek = (_session: SessionSummary): void => {
    setPeekActive((prev) => !prev);
  };

  const handleNavigate = (session: SessionSummary): void => {
    setPeekedId(session.id);
  };

  const handleClose = (): void => {
    setPeekActive(false);
    setPeekedId(null);
    props.onClose();
  };

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
        <text fg={COLORS.textMuted}>
          {" — Enter to resume · Space to peek · Esc to cancel"}
        </text>
      </box>

      {/* Session list */}
      <SelectOverlay
        items={sessions()}
        getLabel={getSessionLabel}
        getDescription={getSessionDescription}
        onSelect={props.onSelect}
        onClose={handleClose}
        focused={props.focused}
        emptyText="No saved sessions yet"
        onPeek={handlePeek}
        onNavigate={handleNavigate}
      />

      {/* Peek panel — shown when peek mode is active; always reflects the highlighted row */}
      <Show when={peekActive() ? peekedSession() : null}>
        {(session: () => SessionSummary) => (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <text fg={COLORS.purple}>{"─".repeat(66)}</text>
            <text fg={COLORS.cyan}>{"Preview"}</text>
            {getSessionPeekLines(session()).map((line, i) => (
              <text fg={i === 0 ? COLORS.white : COLORS.textMuted}>{line}</text>
            ))}
          </box>
        )}
      </Show>
    </box>
  );
}
