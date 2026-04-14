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
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { Show, Switch, Match, createEffect, createMemo, createSignal, on, useContext } from "solid-js";
import type { Accessor } from "solid-js";
import type { ApprovalDecision } from "@koi/core/middleware";
import { COMMAND_DEFINITIONS, type CommandDef } from "./commands/command-definitions.js";
import type { SlashCommand } from "./commands/slash-detection.js";
import { AgentsView } from "./components/AgentsView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ConversationView } from "./components/ConversationView.js";
import { DoctorView } from "./components/DoctorView.js";
import { HelpView } from "./components/HelpView.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { SessionRename } from "./components/SessionRename.js";
import { SessionsView } from "./components/SessionsView.js";
import { CostDashboardView } from "./components/CostDashboardView.js";
import { TrajectoryView } from "./components/TrajectoryView.js";
import { StatusBar } from "./components/StatusBar.js";
import { handleGlobalKey } from "./keyboard.js";
import type { TuiStore } from "./state/store.js";
import type { SessionSummary, TuiModal, TuiView } from "./state/types.js";
import { copyToClipboard } from "./utils/clipboard.js";
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
  "nav:agents": "agents",
  "nav:trajectory": "trajectory",
  "nav:cost": "cost",
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
  /**
   * Called when the user selects a command from the palette or types a slash
   * command in the input. `args` is the trimmed text after the command name
   * (e.g., `/rewind 3` → `args = "3"`); empty string when no args were typed.
   * Handlers that don't need args can ignore the parameter.
   */
  readonly onCommand: (commandId: string, args: string) => void;
  /** Called when the user selects a session to resume. */
  readonly onSessionSelect: (sessionId: string) => void;
  /** Called when the user submits a message in the conversation view. */
  readonly onSubmit: (text: string) => void;
  /** Called when the user triggers Ctrl+C interrupt. */
  readonly onInterrupt: () => void;
  /** Called when the user responds to a permission prompt (y/n/a). */
  readonly onPermissionRespond: (requestId: string, decision: ApprovalDecision) => void;
  /**
   * Called when a turn completes (agentStatus transitions processing → idle).
   * Bridge can use this for BEL notification, desktop notification, etc. (#16).
   */
  readonly onTurnComplete?: (() => void) | undefined;
  /**
   * Called when the user forks the current session (#13).
   * Bridge handles creating the new session from the fork.
   */
  readonly onFork?: (() => void) | undefined;
  /**
   * Called when the user pastes an image from clipboard via Ctrl+V (#11).
   * Bridge collects these and includes them as image ContentBlocks on next submit.
   */
  readonly onImageAttach?: ((image: { readonly url: string; readonly mime: string }) => void) | undefined;
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
  const renderer = useRenderer();

  // Decision 13A: minimal selectors — only re-render on view/modal changes.
  // Zero re-renders during streaming text_delta events.
  const activeView = useTuiStore((s) => s.activeView);
  const modal = useTuiStore((s) => s.modal);
  const agentStatus = useTuiStore((s) => s.agentStatus);

  // #16: notify bridge when a turn completes (processing → idle transition)
  createEffect(
    on(agentStatus, (status, prevStatus) => {
      if (prevStatus === "processing" && status === "idle") {
        props.onTurnComplete?.();
      }
    }),
  );

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

  // Workaround: reconcile() doesn't reliably trigger SolidJS reactivity for
  // primitive property changes in large state objects. Use a dedicated signal
  // that's explicitly updated via store subscription.
  const [viewSignal, setViewSignal] = createSignal(activeView());
  store.subscribe(() => {
    const current = store.getState().activeView;
    setViewSignal((prev) => (prev === current ? prev : current));
  });

  const hasModal = () => modal() !== null;

  // Narrows the modal to a permission-prompt for type-safe child access.
  // Using createMemo avoids a type assertion and keeps the child render pure.
  const permissionModal = createMemo(() => {
    const m = modal();
    if (m !== null && m.kind === "permission-prompt") return m;
    return null;
  });

  // #15: message timeline navigation state (local, not in TuiState)
  // `let` justified: mutable index for Ctrl+Up/Down user-turn cycling
  let turnNavIndex = -1;

  // ── Global keyboard handler ───────────────────────────────────────────────
  // Reads state at event-time via store.getState() — no stale-closure risk.
  useKeyboard((event: KeyEvent): void => {
    // Ctrl+E: toggle tool result expansion — expand all or collapse all (Decision 8A)
    if (event.ctrl && event.name === "e") {
      store.dispatch({ kind: "toggle_all_tools_expanded" });
      return;
    }

    // #15: Ctrl+Up/Down — cycle through user turns in the conversation
    // Tracks which user turn is "active" (local only; programmatic scroll added
    // once OpenTUI exposes a scrollTo API on <scrollbox>).
    if (event.ctrl && (event.name === "up" || event.name === "down")) {
      const state = store.getState();
      if (state.activeView !== "conversation" || state.modal !== null) return;
      const userTurnCount = state.messages.filter((m) => m.kind === "user").length;
      if (userTurnCount === 0) return;
      if (event.name === "up") {
        turnNavIndex = turnNavIndex < 0 ? userTurnCount - 1 : Math.max(0, turnNavIndex - 1);
      } else {
        turnNavIndex = turnNavIndex < 0 ? 0 : Math.min(userTurnCount - 1, turnNavIndex + 1);
      }
      // TODO: scroll MessageList to turnNavIndex once OpenTUI exposes scrollTo API
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
      onInterrupt: () => {
        // Ctrl+C with active selection → copy to clipboard (fallback for
        // terminals where Ctrl+C reaches the app). Primary copy path is
        // copy-on-select in MessageList.
        const sel = renderer.getSelection();
        const text = sel?.getSelectedText();
        if (text && text.length > 0 && copyToClipboard(text)) {
          renderer.clearSelection();
          // clearSelection() doesn't emit a null selection event, so
          // MessageList's onSelectionEnd never fires. Dispatch resume_follow
          // to re-enable auto-scroll from the Ctrl+C path.
          store.dispatch({ kind: "resume_follow" });
        } else {
          // Copy failed or no selection — interrupt as normal.
          // Clear stale selection so next Ctrl+C doesn't re-enter copy path.
          if (sel) renderer.clearSelection();
          props.onInterrupt();
        }
      },
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
          setViewSignal("conversation");
        }
      },
    });
  });

  // ── Modal callbacks ───────────────────────────────────────────────────────

  const dismissModal = (): void => {
    store.dispatch({ kind: "set_modal", modal: null });
  };

  const handleCommandSelect = (cmd: CommandDef, args = ""): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    const navView = resolveNavCommand(cmd.id);
    if (navView !== null) {
      store.dispatch({ kind: "set_view", view: navView });
      setViewSignal(navView);
      return;
    }
    // session:resume opens the session picker modal inline — host is not involved.
    if (cmd.id === "session:resume") {
      store.dispatch({ kind: "set_modal", modal: { kind: "session-picker" } });
      return;
    }
    if (cmd.id === "session:rename") {
      store.dispatch({ kind: "set_modal", modal: { kind: "session-rename" } });
      return;
    }
    if (cmd.id === "session:fork") {
      props.onFork?.();
      return;
    }
    if (cmd.id === "display:thinking") {
      store.dispatch({ kind: "toggle_thinking" });
      return;
    }
    props.onCommand(cmd.id, args);
  };

  const handleSessionSelect = (session: SessionSummary): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    props.onSessionSelect(session.id);
  };

  // #14: session rename handler
  const handleRename = (newName: string): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    props.onCommand("session:rename", newName);
  };

  const handleSlashDetected = (query: string | null): void => {
    store.dispatch({ kind: "set_slash_query", query });
  };

  const handleSlashSelect = (cmd: SlashCommand, args: string): void => {
    process.stderr.write(`[tui-slash-select] cmd.name=${cmd.name} args="${args}"\n`);
    store.dispatch({ kind: "set_slash_query", query: null });
    const commandDef = findCommandBySlashName(cmd.name);
    process.stderr.write(`[tui-slash-select] commandDef=${commandDef?.id ?? "NOT FOUND"}\n`);
    if (commandDef !== undefined) {
      handleCommandSelect(commandDef, args);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Status bar — always visible */}
      <StatusBar width={terminalDimensions().width} />

      {/* View layer — one active at a time */}
      <Switch fallback={<box />}>
        <Match when={viewSignal() === "conversation"}>
          <ConversationView
            onSubmit={props.onSubmit}
            onSlashDetected={handleSlashDetected}
            onSlashSelect={handleSlashSelect}
            onImageAttach={props.onImageAttach}
            focused={!hasModal()}
            syntaxStyle={props.syntaxStyle}
            treeSitterClient={props.treeSitterClient}
          />
        </Match>
        <Match when={viewSignal() === "sessions"}>
          <SessionsView />
        </Match>
        <Match when={viewSignal() === "doctor"}>
          <DoctorView />
        </Match>
        <Match when={viewSignal() === "help"}>
          <HelpView />
        </Match>
        <Match when={viewSignal() === "agents"}>
          <AgentsView />
        </Match>
        <Match when={viewSignal() === "trajectory"}>
          <TrajectoryView />
        </Match>
        <Match when={viewSignal() === "cost"}>
          <CostDashboardView />
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
      {/* #14: session rename modal */}
      <Show when={modal()?.kind === "session-rename"}>
        <SessionRename
          onRename={handleRename}
          onClose={dismissModal}
          focused={true}
        />
      </Show>
    </box>
  );
}
