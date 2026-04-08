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

import type { KeyEvent, SyntaxStyle, TreeSitterClient } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { Show, Switch, Match, createEffect, createMemo, useContext } from "solid-js";
import type { Accessor } from "solid-js";
import type { ApprovalDecision } from "@koi/core/middleware";
import { COMMAND_DEFINITIONS, type CommandDef } from "./commands/command-definitions.js";
import type { SlashCommand } from "./commands/slash-detection.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ConversationView } from "./components/ConversationView.js";
import { DoctorView } from "./components/DoctorView.js";
import { HelpView } from "./components/HelpView.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { SessionsView } from "./components/SessionsView.js";
import { TrajectoryView } from "./components/TrajectoryView.js";
import { StatusBar } from "./components/StatusBar.js";
import { handleGlobalKey } from "./keyboard.js";
import type { TuiStore } from "./state/store.js";
import type { SessionSummary, TuiModal, TuiView } from "./state/types.js";
import {
  StoreContext,
  useTuiStore,
} from "./store-context.js";

// ---------------------------------------------------------------------------
// Nav command routing
// ---------------------------------------------------------------------------

/**
 * Maps navigation command IDs to their target TuiView.
 * Navigation commands are handled inside TuiRoot — they never bubble up to the
 * CLI's onCommand callback. Only engine-affecting commands (agent:*, session:*,
 * system:*) are forwarded via onCommand.
 */
const NAV_VIEW_MAP: Partial<Record<string, TuiView>> = {
  "nav:sessions": "sessions",
  "nav:doctor": "doctor",
  "nav:help": "help",
  "nav:trajectory": "trajectory",
};

/**
 * Returns the TuiView for a navigation command ID, or null for engine commands.
 * Exported for testing — do not rely on this in external packages.
 */
export function resolveNavCommand(commandId: string): TuiView | null {
  return NAV_VIEW_MAP[commandId] ?? null;
}

function findCommandBySlashName(name: string): CommandDef | undefined {
  return COMMAND_DEFINITIONS.find(
    (c) => c.id.split(":")[1] === name || c.id === name,
  );
}

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
  /**
   * Optional syntax highlighting style. Required alongside treeSitterClient
   * for full markdown rendering in TextBlock; also enables <code> syntax
   * highlighting in tool call blocks (works without treeSitterClient).
   */
  readonly syntaxStyle?: SyntaxStyle | undefined;
  /**
   * Optional tree-sitter client for rich markdown rendering in TextBlock.
   * When provided alongside syntaxStyle, assistant text blocks use <markdown>
   * with full prose/heading/code-fence rendering. When omitted, TextBlock
   * falls back to <text> (prose renders correctly; see #1542 for full init).
   */
  readonly treeSitterClient?: TreeSitterClient | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TuiRoot(props: TuiRootProps): JSX.Element {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error("TuiRoot must be rendered inside <StoreContext.Provider>");
  }

  // Decision 13A: minimal selectors — only re-render on view/modal changes.
  // Zero re-renders during streaming text_delta events.
  const activeView = useTuiStore((s) => s.activeView);
  const modal = useTuiStore((s) => s.modal);

  // DEV ONLY: keyboard focus invariant.
  // Exactly one "zone" must have focused=true at all times:
  //   - ConversationView (when modal === null → focused={!hasModal()} = true)
  //   - The active modal (when modal !== null → modal gets focused={true})
  // If this assertion fires, a refactor has broken the mutual-exclusion contract
  // and keyboard events will double-fire. This is the anchor point for any
  // future migration to OpenTUI's priority-based keyboard routing API.
  if (process.env.NODE_ENV !== "production") {
    createEffect(() => {
      const m = modal();
      const focusedZones = [
        m === null,   // ConversationView: focused={!hasModal()}
        m !== null,   // active modal: focused={true}
      ].filter(Boolean).length;
      console.assert(
        focusedZones === 1,
        "[koi/tui] Focus invariant: expected exactly 1 focused zone, got %d (modal=%s). " +
          "Update keyboard routing if adding modal stacking.",
        focusedZones,
        m?.kind ?? "none",
      );
    });
  }

  // Terminal width for StatusBar compact mode (read-only hook, not state I/O)
  const terminalDimensions = useTerminalDimensions();

  const hasModal = () => modal() !== null;

  // Narrows the modal to a permission-prompt for type-safe child access.
  // Using createMemo avoids a type assertion and keeps the child render pure.
  const permissionModal = createMemo(() => {
    const m = modal();
    if (m !== null && m.kind === "permission-prompt") return m;
    return null;
  });

  // ── Global keyboard handler ───────────────────────────────────────────────
  // Reads state at event-time via store.getState() — no stale-closure risk.
  useKeyboard((event: KeyEvent): void => {
    // Ctrl+E: toggle tool result expansion (Decision 15A)
    if (event.ctrl && event.name === "e") {
      store.dispatch({ kind: "toggle_tools_expanded" });
      return;
    }

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
    // Navigation commands are handled here — no CLI callback needed.
    const navView = resolveNavCommand(cmd.id);
    if (navView !== null) {
      store.dispatch({ kind: "set_view", view: navView });
      return;
    }
    // session:resume opens the session picker modal inline — host is not involved.
    if (cmd.id === "session:resume") {
      store.dispatch({ kind: "set_modal", modal: { kind: "session-picker" } });
      return;
    }
    props.onCommand(cmd.id);
  };

  const handleSessionSelect = (session: SessionSummary): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    props.onSessionSelect(session.id);
  };

  const handleSlashDetected = (query: string | null): void => {
    store.dispatch({ kind: "set_slash_query", query });
  };

  const handleSlashSelect = (cmd: SlashCommand): void => {
    store.dispatch({ kind: "set_slash_query", query: null });
    const commandDef = findCommandBySlashName(cmd.name);
    if (commandDef !== undefined) {
      handleCommandSelect(commandDef);
    }
  };

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
            onSlashSelect={handleSlashSelect}
            focused={!hasModal()}
            syntaxStyle={props.syntaxStyle}
            treeSitterClient={props.treeSitterClient}
          />
        </Match>
        <Match when={activeView() === "sessions"}>
          <SessionsView />
        </Match>
        <Match when={activeView() === "doctor"}>
          <DoctorView />
        </Match>
        <Match when={activeView() === "help"}>
          <HelpView />
        </Match>
        <Match when={activeView() === "trajectory"}>
          <TrajectoryView />
        </Match>
      </Switch>

      {/* Modal layer — overlays the active view (Decision 3A: single slot).
          Uses Show instead of Switch because Switch returns "" when no Match
          fires, and OpenTUI throws on orphan text nodes inserted into a box.
          Show returns null when its condition is false, which insertExpression
          handles safely via cleanChildren. */}
      <Show when={modal()?.kind === "command-palette"}>
        <CommandPalette
          onSelect={handleCommandSelect}
          onClose={dismissModal}
          focused={true}
        />
      </Show>
      <Show when={permissionModal()}>
        {(m: Accessor<TuiModal & { readonly kind: "permission-prompt" }>) => (
          <PermissionPrompt
            prompt={m().prompt}
            onRespond={props.onPermissionRespond}
            focused={true}
          />
        )}
      </Show>
      <Show when={modal()?.kind === "session-picker"}>
        <SessionPicker
          onSelect={handleSessionSelect}
          onClose={dismissModal}
          focused={true}
        />
      </Show>
    </box>
  );
}
