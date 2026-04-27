/**
 * TuiRoot — top-level TUI component composing views, modals, and the status bar.
 *
 * Architecture decisions implemented:
 * - 1A  Two-layer keyboard: root owns Ctrl+P / Ctrl+N / Ctrl+C / Esc globally.
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
import {
  Show,
  Switch,
  Match,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import type { Accessor } from "solid-js";
import type { ApprovalDecision } from "@koi/core/middleware";
import { COMMAND_DEFINITIONS, type CommandDef } from "./commands/command-definitions.js";
import type { SlashCommand } from "./commands/slash-detection.js";
import { AgentsView } from "./components/AgentsView.js";
import { McpView } from "./components/McpView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ConversationView } from "./components/ConversationView.js";
import { DoctorView } from "./components/DoctorView.js";
import { GovernanceView } from "./components/GovernanceView.js";
import { HelpView } from "./components/HelpView.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { SessionRename } from "./components/SessionRename.js";
import { CostDashboardView } from "./components/CostDashboardView.js";
import { PluginsView } from "./components/PluginsView.js";
import { TrajectoryView } from "./components/TrajectoryView.js";
import { StatusBar } from "./components/StatusBar.js";
import { ToastOverlay } from "./components/Toast.js";
import { handleGlobalKey } from "./keyboard.js";
import type { TuiStore } from "./state/store.js";
import type {
  FetchModelsResult,
  ModelEntry,
  SessionSummary,
  TuiModal,
  TuiView,
} from "./state/types.js";
import {
  StoreContext,
  useTuiStore,
} from "./store-context.js";
import { isBelowOsc52Limit } from "./utils/clipboard.js";

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
  "nav:doctor": "doctor",
  "nav:governance": "governance",
  "nav:help": "help",
  "nav:agents": "agents",
  "nav:trajectory": "trajectory",
  "nav:cost": "cost",
  "nav:mcp": "mcp",
  "nav:plugins": "plugins",
};

/**
 * Returns the TuiView for a navigation command ID, or null for engine commands.
 * Exported for testing — do not rely on this in external packages.
 */
export function resolveNavCommand(commandId: string): TuiView | null {
  return NAV_VIEW_MAP[commandId] ?? null;
}

/**
 * Side-effect plan for `system:governance-reset`:
 * 1. Clear in-memory alerts in the TUI store.
 * 2. Forward to the host via onCommand so the bridge can reset its
 *    alert-tracker dedup state.
 *
 * Exported for testing — do not rely on this in external packages.
 */
export function executeGovernanceReset(
  store: TuiStore,
  onCommand: (commandId: string, args: string) => void,
  args: string,
): void {
  store.dispatch({ kind: "clear_governance_alerts" });
  onCommand("system:governance-reset", args);
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
  readonly onSubmit: (text: string, mode?: "queue" | "interrupt") => void;
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
  /**
   * Called when the @-mention query changes in the input area (#10).
   * The host uses this to run file completion (glob / git ls-files)
   * and dispatch set_at_results back to the store.
   * Null signals the overlay was dismissed.
   */
  readonly onAtQuery?: ((query: string | null) => void) | undefined;
  /**
   * Called when the model picker opens. The host performs the provider
   * `/models` fetch (L2 TUI has no network code) and resolves with the
   * typed result. TuiRoot dispatches `model_picker_fetched` on resolve.
   */
  readonly onFetchModels?: (() => Promise<FetchModelsResult>) | undefined;
  /**
   * Called when the user selects a model in the picker. The host mutates
   * the current-model middleware box so subsequent turns use the new model.
   *
   * The full `ModelEntry` is forwarded (not just the id) so the host can
   * plumb per-model metadata — specifically `contextLength` — into the
   * runtime's per-turn budget resolution for models absent from the local
   * registry.
   *
   * Returns `true` when the switch was applied, `false` when the host
   * refused (e.g. a run is still in flight). TuiRoot only dispatches
   * `model_switched` and the success toast on a confirmed mutation.
   */
  readonly onModelSwitch?: ((model: ModelEntry) => boolean | void) | undefined;
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
  const toasts = useTuiStore((s) => s.toasts);
  const governance = useTuiStore((s) => s.governance);

  // #16: notify bridge when a turn completes (processing → idle transition)
  createEffect(
    on(agentStatus, (status, prevStatus) => {
      if (prevStatus === "processing" && status === "idle") {
        props.onTurnComplete?.();
      }
    }),
  );

  // Refresh session list whenever the session-picker modal opens, regardless
  // of which component opened it (command palette, /sessions, SpawnBlock click).
  createEffect(
    on(modal, (m) => {
      if (m?.kind === "session-picker") {
        props.onCommand("session:sessions", "");
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
  // Critical: this is the sole production store subscriber and it drives the
  // view-sync signal the renderer reads. If it throws, the TUI loses its
  // refresh path — escalate to fatal teardown via the store's onFatal hook
  // instead of leaving a silent dead UI (#1940).
  const unsubscribeViewSync = store.subscribe(
    () => {
      const current = store.getState().activeView;
      setViewSignal((prev) => (prev === current ? prev : current));
    },
    { critical: true },
  );
  // Restartable createTuiApp.stop() / start() cycles must not leak this
  // subscription. Without cleanup, a stale callback from a previous mount
  // would still be flagged critical and could escalate the new instance to
  // fatal teardown on a later dispatch.
  onCleanup(unsubscribeViewSync);

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
        if (text && text.length > 0 && process.stdout.isTTY && isBelowOsc52Limit(text) && renderer.copyToClipboardOSC52(text)) {
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
      onNewSession: () => {
        const cmd = COMMAND_DEFINITIONS.find((c) => c.id === "session:new");
        if (cmd !== undefined) handleCommandSelect(cmd);
      },
      onOpenSessions: () => {
        const cmd = COMMAND_DEFINITIONS.find((c) => c.id === "session:sessions");
        if (cmd !== undefined) handleCommandSelect(cmd);
      },
    });
  });

  // ── Modal callbacks ───────────────────────────────────────────────────────

  const dismissModal = (): void => {
    store.dispatch({ kind: "set_modal", modal: null });
  };

  /** Open the session picker. The createEffect above auto-refreshes the list. */
  const openSessionPicker = (): void => {
    store.dispatch({ kind: "set_modal", modal: { kind: "session-picker" } });
  };

  // Cache the /models fetch so reopening the picker within the same process
  // does not hammer the provider. Keyed by the callback identity — if the host
  // swaps in a new fetcher (baseUrl/apiKey change), the cache naturally misses.
  // `let`: justified — single-slot cache, updated on first fetch.
  let cachedModelFetch:
    | { readonly fetcher: () => Promise<FetchModelsResult>; readonly pending: Promise<FetchModelsResult> }
    | null = null;

  const openModelPicker = (initialQuery: string): void => {
    store.dispatch({
      kind: "set_modal",
      modal: { kind: "model-picker", query: initialQuery, status: "loading", models: [] },
    });
    const fetcher = props.onFetchModels;
    if (fetcher === undefined) {
      store.dispatch({
        kind: "model_picker_fetched",
        result: { ok: false, error: "Model fetching is not configured." },
      });
      return;
    }
    let pending: Promise<FetchModelsResult>;
    if (cachedModelFetch !== null && cachedModelFetch.fetcher === fetcher) {
      pending = cachedModelFetch.pending;
    } else {
      pending = fetcher();
      cachedModelFetch = { fetcher, pending };
    }
    // Capture the promise we committed to so a later invalidation (e.g. the
    // user reopens the picker after the failure below landed) can't racily
    // clobber a fresher attempt.
    const settled = pending;
    void settled
      .then((result) => {
        // Invalidate the cache on failure so reopening the picker retries —
        // transient outages (timeouts, auth blips) shouldn't stick for the
        // rest of the process.
        if (!result.ok && cachedModelFetch?.pending === settled) {
          cachedModelFetch = null;
        }
        store.dispatch({ kind: "model_picker_fetched", result });
      })
      .catch(() => {
        if (cachedModelFetch?.pending === settled) {
          cachedModelFetch = null;
        }
      });
  };

  const handleModelSelect = (model: ModelEntry): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    // Host owns the authoritative in-flight signal (e.g. AbortController).
    // `agentStatus` lags the submit→first-event gap, so we defer the
    // refusal decision to the host and react to its boolean result.
    // When the host returns `undefined` (older callers) we assume success
    // for backwards compatibility.
    const applied = props.onModelSwitch?.(model);
    if (applied === false) {
      store.dispatch({
        kind: "add_info",
        message: "[Cannot switch models while a turn is in flight — finish or Esc-interrupt first.]",
      });
      return;
    }
    store.dispatch({ kind: "model_switched", model: model.id });
    store.dispatch({ kind: "add_info", message: `[Model switched to ${model.id}]` });
  };

  const handleCommandSelect = (cmd: CommandDef, args = ""): void => {
    store.dispatch({ kind: "set_modal", modal: null });
    // nav:mcp needs host-side data fetch before showing the view,
    // so it routes through onCommand instead of the pure-nav path.
    if (cmd.id === "nav:mcp") {
      props.onCommand(cmd.id, args);
      return;
    }
    const navView = resolveNavCommand(cmd.id);
    if (navView !== null) {
      store.dispatch({ kind: "set_view", view: navView });
      setViewSignal(navView);
      return;
    }
    // session:resume opens the session picker modal inline — host is not involved.
    if (cmd.id === "session:sessions") {
      openSessionPicker();
      return;
    }
    // system:model-switch opens the model picker modal inline. The host
    // performs the /models fetch via onFetchModels and mutates the current-
    // model middleware box via onModelSwitch.
    if (cmd.id === "system:model-switch") {
      openModelPicker(args);
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
    if (cmd.id === "system:governance-reset") {
      executeGovernanceReset(store, props.onCommand, args);
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
    store.dispatch({ kind: "set_slash_query", query: null });
    // `/model <query>` with args opens the picker prefilled with the query.
    // Bare `/model` falls through to `system:model` (info notice).
    if (cmd.name === "model" && args.trim().length > 0) {
      openModelPicker(args.trim());
      return;
    }
    const commandDef = findCommandBySlashName(cmd.name);
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
            onAtQuery={props.onAtQuery}
            onImageAttach={props.onImageAttach}
            focused={!hasModal()}
            syntaxStyle={props.syntaxStyle}
            treeSitterClient={props.treeSitterClient}
          />
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
        <Match when={viewSignal() === "mcp"}>
          <McpView onCommand={props.onCommand} />
        </Match>
        <Match when={viewSignal() === "plugins"}>
          <PluginsView />
        </Match>
        <Match when={viewSignal() === "governance"}>
          <GovernanceView slice={governance()} />
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
            terminalWidth={terminalDimensions().width}
            terminalHeight={terminalDimensions().height}
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
      {/* Model picker modal — fuzzy list of provider models. */}
      <Show when={modal()?.kind === "model-picker"}>
        <ModelPicker
          onSelect={handleModelSelect}
          onClose={dismissModal}
          focused={true}
        />
      </Show>
      {/* Toast overlay — top-right transient notifications (gov-9).
          zIndex=100 intentionally exceeds MODAL_POSITION.zIndex (20)
          so toasts remain visible over modals. Any new modal added
          here MUST use MODAL_POSITION (or another zIndex < 100) to
          preserve this ordering. */}
      <ToastOverlay
        toasts={toasts()}
        onDismiss={(id) => store.dispatch({ kind: "dismiss_toast", id })}
      />
    </box>
  );
}
