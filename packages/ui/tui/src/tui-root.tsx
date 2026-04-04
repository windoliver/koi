/**
 * TuiRoot — top-level TUI component composing views, modals, and the status bar.
 *
 * Architecture decisions implemented:
 * - 1A  Two-layer keyboard: root owns Ctrl+P / Ctrl+C / Esc globally.
 *       Modals receive focused={true} and own their internal keys via useKeyboard.
 * - 2A  layoutTier is read from store state (set by createTuiApp resize listener).
 * - 3A  Single modal slot (TuiModal | null). One modal at a time.
 * - 13A Root selects only activeView + modal — zero re-renders during streaming.
 * - 14A Keyboard handler is stable via useCallback with minimal deps.
 *
 * Must be rendered inside <StoreContext.Provider value={store}> (set up by
 * createTuiApp, not by TuiRoot itself).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { memo, useCallback, useContext } from "react";
import type { ApprovalDecision } from "@koi/core/middleware";
import type { CommandDef } from "./commands/command-definitions.js";
import { CommandPalette } from "./components/CommandPalette.js";
import {
  ConversationView,
  DoctorPlaceholder,
  HelpPlaceholder,
  SessionsPlaceholder,
} from "./components/ConversationView.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { StatusBar } from "./components/StatusBar.js";
import { handleGlobalKey } from "./keyboard.js";
import type { SessionSummary } from "./state/types.js";
import { StoreContext, useTuiStore } from "./store-context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TuiRootProps {
  /** Called when the user selects a command from the palette. */
  readonly onCommand: (commandId: string) => void;
  /** Called when the user selects a session to resume. */
  readonly onSessionSelect: (sessionId: string) => void;
  /** Called when the user submits a message in the conversation view. */
  readonly onSubmit: (text: string) => void;
  /** Called when the user triggers Ctrl+C interrupt. */
  readonly onInterrupt: () => void;
  /** Called when the user responds to a permission prompt (y/n/a). */
  readonly onPermissionRespond: (requestId: string, decision: ApprovalDecision) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TuiRoot: React.NamedExoticComponent<TuiRootProps> = memo(
  function TuiRoot(props: TuiRootProps): React.ReactNode {
    const { onCommand, onSessionSelect, onSubmit, onInterrupt, onPermissionRespond } = props;

    const store = useContext(StoreContext);
    if (store === null) {
      throw new Error("TuiRoot must be rendered inside <StoreContext.Provider>");
    }

    // Decision 13A: minimal selectors — only re-render on view/modal changes.
    // Zero re-renders during streaming text_delta events.
    const activeView = useTuiStore((s) => s.activeView);
    const modal = useTuiStore((s) => s.modal);

    // Terminal width for StatusBar compact mode (read-only hook, not state I/O)
    const { width } = useTerminalDimensions();

    const hasModal = modal !== null;

    // ── Global keyboard handler ───────────────────────────────────────────────
    // Decision 14A: stable via useCallback. Reads state at event-time via
    // store.getState() — no stale-closure risk. Re-created only when onInterrupt
    // changes (should be stable from createTuiApp, but safe to list as dep).
    const handleKey = useCallback(
      (event: KeyEvent): void => {
        handleGlobalKey(event, store.getState(), {
          onTogglePalette: () => {
            const s = store.getState();
            // Never interrupt an active permission prompt — it is bridge-owned
            // and must be resolved through onPermissionRespond, not replaced.
            if (s.modal?.kind === "permission-prompt") return;
            store.dispatch({
              kind: "set_modal",
              modal:
                s.modal?.kind === "command-palette"
                  ? null
                  : { kind: "command-palette", query: "" },
            });
          },
          onInterrupt,
          onDismissModal: () => {
            const s = store.getState();
            if (s.modal?.kind === "permission-prompt") {
              // Route Esc through the bridge — produces an explicit deny so the
              // engine-side approval Promise resolves rather than hanging until
              // the 30s timeout.
              onPermissionRespond(s.modal.prompt.requestId, {
                kind: "deny",
                reason: "User dismissed",
              });
              // Bridge.respond() dispatches permission_response which clears modal.
            } else {
              store.dispatch({ kind: "set_modal", modal: null });
            }
          },
          onBack: () => {
            if (store.getState().activeView !== "conversation") {
              store.dispatch({ kind: "set_view", view: "conversation" });
            }
          },
        });
      },
      [store, onInterrupt, onPermissionRespond],
    );

    useKeyboard(handleKey);

    // ── Modal callbacks ───────────────────────────────────────────────────────

    const dismissModal = useCallback(
      () => store.dispatch({ kind: "set_modal", modal: null }),
      [store],
    );

    const handleCommandSelect = useCallback(
      (cmd: CommandDef) => {
        store.dispatch({ kind: "set_modal", modal: null });
        onCommand(cmd.id);
      },
      [store, onCommand],
    );

    const handleSessionSelect = useCallback(
      (session: SessionSummary) => {
        store.dispatch({ kind: "set_modal", modal: null });
        onSessionSelect(session.id);
      },
      [store, onSessionSelect],
    );

    // Slash detection is a no-op here; host can extend via custom ConversationView
    const handleSlashDetected = useCallback((_query: string | null): void => {}, []);

    // ── Render ────────────────────────────────────────────────────────────────
    return (
      <box flexDirection="column" width="100%" height="100%">
        {/* Status bar — always visible */}
        <StatusBar width={width} />

        {/* View layer — one active at a time */}
        {activeView === "conversation" && (
          <ConversationView
            onSubmit={onSubmit}
            onSlashDetected={handleSlashDetected}
            focused={!hasModal}
          />
        )}
        {activeView === "sessions" && <SessionsPlaceholder />}
        {activeView === "doctor" && <DoctorPlaceholder />}
        {activeView === "help" && <HelpPlaceholder />}

        {/* Modal layer — overlays the active view (Decision 3A: single slot) */}
        {modal?.kind === "command-palette" && (
          <CommandPalette
            onSelect={handleCommandSelect}
            onClose={dismissModal}
            focused={true}
          />
        )}
        {modal?.kind === "permission-prompt" && (
          <PermissionPrompt
            prompt={modal.prompt}
            onRespond={onPermissionRespond}
            focused={true}
          />
        )}
        {modal?.kind === "session-picker" && (
          <SessionPicker
            onSelect={handleSessionSelect}
            onClose={dismissModal}
            focused={true}
          />
        )}
      </box>
    );
  },
);
