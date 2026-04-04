/**
 * TuiRoot — top-level TUI component composing views, modals, and the status bar.
 *
 * Architecture decisions implemented:
 * - 1A  Two-layer keyboard: root owns Ctrl+P / Ctrl+C / Esc globally.
 *       Modals receive focused={true} and own their internal keys via useKeyboard.
 * - 2A  layoutTier is read from store state (set by createTuiApp resize listener).
 * - 3A  Single modal slot (TuiModal | null). One modal at a time.
 * - 13A Root selects only activeView + modal — zero re-renders during streaming.
 * - 14A Keyboard handler reads state at event-time — no stale closure risk.
 *
 * Must be rendered inside <StoreContext.Provider value={store}> (set up by
 * createTuiApp, not by TuiRoot itself).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { Switch, Match, useContext } from "solid-js";
import type { Accessor } from "solid-js";
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
import type { TuiStore } from "./state/store.js";
import type { SessionSummary, TuiModal } from "./state/types.js";
import {
  StoreContext,
  TuiStateContext,
  createStoreSignal,
  useTuiStore,
} from "./store-context.js";

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

export function TuiRoot(props: TuiRootProps): JSX.Element {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error("TuiRoot must be rendered inside <StoreContext.Provider>");
  }

  // Create one shared state signal for the entire subtree. All useTuiStore
  // selectors in child components share this single subscription, guaranteeing
  // snapshot consistency — every selector sees the same post-dispatch state.
  // Providing TuiStateContext here restores the old single-provider embedding
  // contract: callers only need <StoreContext.Provider value={store}>.
  const stateSignal = createStoreSignal(store);

  return (
    <TuiStateContext.Provider value={stateSignal}>
      <TuiRootInner {...props} store={store} />
    </TuiStateContext.Provider>
  );
}

function TuiRootInner(props: TuiRootProps & { readonly store: TuiStore }): JSX.Element {
  const store = props.store;

  // Decision 13A: minimal selectors — only re-render on view/modal changes.
  // Zero re-renders during streaming text_delta events.
  const activeView = useTuiStore((s) => s.activeView);
  const modal = useTuiStore((s) => s.modal);

  // Terminal width for StatusBar compact mode (read-only hook, not state I/O)
  const terminalDimensions = useTerminalDimensions();

  const hasModal = () => modal() !== null;

  // ── Global keyboard handler ───────────────────────────────────────────────
  // Reads state at event-time via store.getState() — no stale-closure risk.
  useKeyboard((event: KeyEvent): void => {
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
      onInterrupt: props.onInterrupt,
      onDismissModal: () => {
        const s = store.getState();
        if (s.modal?.kind === "permission-prompt") {
          // Route Esc through the bridge — produces an explicit deny so the
          // engine-side approval Promise resolves rather than hanging until
          // the 30s timeout.
          props.onPermissionRespond(s.modal.prompt.requestId, {
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
  });

  // ── Modal callbacks ───────────────────────────────────────────────────────

  const dismissModal = (): void => {
    store.dispatch({ kind: "set_modal", modal: null });
  };

  const handleCommandSelect = (cmd: CommandDef): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    props.onCommand(cmd.id);
  };

  const handleSessionSelect = (session: SessionSummary): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    props.onSessionSelect(session.id);
  };

  // Slash detection is a no-op here; host can extend via custom ConversationView
  const handleSlashDetected = (_query: string | null): void => {};

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Status bar — always visible */}
      <StatusBar width={terminalDimensions().width} />

      {/* View layer — one active at a time */}
      <Switch>
        <Match when={activeView() === "conversation"}>
          <ConversationView
            onSubmit={props.onSubmit}
            onSlashDetected={handleSlashDetected}
            focused={!hasModal()}
          />
        </Match>
        <Match when={activeView() === "sessions"}>
          <SessionsPlaceholder />
        </Match>
        <Match when={activeView() === "doctor"}>
          <DoctorPlaceholder />
        </Match>
        <Match when={activeView() === "help"}>
          <HelpPlaceholder />
        </Match>
      </Switch>

      {/* Modal layer — overlays the active view (Decision 3A: single slot) */}
      <Switch>
        <Match when={modal()?.kind === "command-palette"}>
          <CommandPalette
            onSelect={handleCommandSelect}
            onClose={dismissModal}
            focused={true}
          />
        </Match>
        <Match when={modal()?.kind === "permission-prompt" ? (modal() as TuiModal & { kind: "permission-prompt" }) : undefined}>
          {(permModal: Accessor<TuiModal & { kind: "permission-prompt" }>) => (
            <PermissionPrompt
              prompt={permModal().prompt}
              onRespond={props.onPermissionRespond}
              focused={true}
            />
          )}
        </Match>
        <Match when={modal()?.kind === "session-picker"}>
          <SessionPicker
            onSelect={handleSessionSelect}
            onClose={dismissModal}
            focused={true}
          />
        </Match>
      </Switch>
    </box>
  );
}
