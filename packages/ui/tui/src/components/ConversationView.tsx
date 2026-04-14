/**
 * ConversationView — the "conversation" screen (activeView === "conversation").
 *
 * Features:
 * - MessageList: scrollable conversation history with auto-scroll
 * - InputArea: text input with slash command detection
 * - SlashOverlay: command prefix overlay
 * - Prompt history: arrow up/down navigates previous prompts (Decision 4.3)
 */

import type { SyntaxStyle, TreeSitterClient } from "@opentui/core";
import type { JSX } from "solid-js";
import { createEffect, createSignal, on, Show, useContext } from "solid-js";
import { COMMAND_DEFINITIONS } from "../commands/command-definitions.js";
import { matchCommands, parseSlashCommand, type SlashCommand } from "../commands/slash-detection.js";
import type { ClipboardImage } from "../utils/clipboard.js";
import { StoreContext, useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
import { AtOverlay } from "./AtOverlay.js";
import { InputArea } from "./InputArea.js";
import { MessageList } from "./message-list.js";
import { SlashOverlay } from "./SlashOverlay.js";

const SLASH_COMMANDS: readonly SlashCommand[] = COMMAND_DEFINITIONS.map((cmd) => ({
  name: cmd.id.split(":")[1] ?? cmd.id,
  description: cmd.description,
}));

const MAX_HISTORY = 100;

export interface ConversationViewProps {
  readonly onSubmit: (text: string) => void;
  readonly onSlashDetected: (query: string | null) => void;
  readonly onSlashSelect?: ((command: SlashCommand, args: string) => void) | undefined;
  readonly onAtQuery?: ((query: string | null) => void) | undefined;
  readonly onImageAttach?: ((image: ClipboardImage) => void) | undefined;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
}

export function ConversationView(props: ConversationViewProps): JSX.Element {
  const slashQuery = useTuiStore((s) => s.slashQuery);
  const atQuery = useTuiStore((s) => s.atQuery);
  const storeCtx = useContext(StoreContext);
  // Incremented on every slash-command selection to clear the textarea text
  const [clearTrigger, setClearTrigger] = createSignal(0);
  // #10: selected @-mention file path to insert into the textarea
  const [atInsertPath, setAtInsertPath] = createSignal<string | null>(null);

  // Checkpoint marker visibility: show the /rewind hint as soon as the user
  // has submitted at least one message. Each user message corresponds to one
  // captured snapshot at turn end, so this is a reliable "rewind is available"
  // signal without coupling the TUI store to the runtime's checkpoint count.
  //
  // We intentionally omit a precise count. The TUI store creates multiple
  // assistant messages per turn (streaming chunks + tool-call blocks) so
  // filtering for "non-streaming assistant messages" overcounts. Showing a
  // stable hint is more useful than a wrong number.
  const hasCapturedTurn = useTuiStore((s) => s.messages.some((m) => m.kind === "user"));

  // Prompt history — session-scoped. Cleared when messages are reset
  // (agent:clear, session:new, session resume) to prevent leaking
  // prior-session prompts into a fresh context.
  const [history, setHistory] = createSignal<readonly string[]>([]);
  // `let` justified: mutable index tracking current position in history navigation
  let historyIdx = -1;
  // `let` justified: stores the draft text before history navigation started
  let draft = "";

  // Clear history when session resets (messages drop to 0).
  // This covers agent:clear, session:new, and session resume — all of which
  // dispatch clear_messages before loading new state.
  const messageCount = useTuiStore((s) => s.messages.length);
  createEffect(
    on(messageCount, (count: number, prev: number | undefined) => {
      if (count === 0 && prev !== undefined && prev > 0) {
        setHistory([]);
        historyIdx = -1;
        draft = "";
      }
    }),
  );

  const dismissOverlay = (): void => {
    props.onSlashDetected(null);
  };

  // #10: @-mention overlay handlers
  const handleAtSelect = (path: string): void => {
    storeCtx?.dispatch({ kind: "set_at_query", query: null });
    storeCtx?.dispatch({ kind: "set_at_results", results: [] });
    props.onAtQuery?.(null);
    // Insert the selected file path into the textarea via the atInsertPath signal.
    // InputArea's deferred effect replaces "@partial" with "@path " and dismisses the overlay.
    setAtInsertPath(path);
    // Reset the signal so the same path can be selected again if needed
    queueMicrotask(() => setAtInsertPath(null));
  };

  const dismissAtOverlay = (): void => {
    storeCtx?.dispatch({ kind: "set_at_query", query: null });
    storeCtx?.dispatch({ kind: "set_at_results", results: [] });
    props.onAtQuery?.(null);
  };

  // Notify host when @-query changes so it can provide file completions
  createEffect(
    on(atQuery, (query: string | null) => {
      props.onAtQuery?.(query);
    }),
  );

  const handleSlashSelect = (command: SlashCommand): void => {
    // Parse args from the current slash query — what the user typed after
    // the command name. The slashQuery state holds the text after `/` so
    // we re-prepend it for parseSlashCommand. For example, if the user
    // typed `/rewind 3`, slashQuery is `"rewind 3"` and parsed.args is `"3"`.
    const query = slashQuery();
    const parsed = query !== null ? parseSlashCommand(`/${query}`) : null;
    const args = parsed?.args ?? "";

    process.stderr.write(`[slash-select] command=${command.name} args="${args}" hasOnSlashSelect=${props.onSlashSelect !== undefined}\n`);
    props.onSlashDetected(null);
    setClearTrigger((n: number) => n + 1);
    props.onSlashSelect?.(command, args);
  };

  /**
   * Handle slash command submitted directly from InputArea (Enter on "/cmd").
   * Parses the command name, finds the matching SlashCommand, and dispatches.
   * This replaces the old flow where SlashOverlay's useKeyboard caught Enter.
   */
  const handleSlashSubmit = (text: string): void => {
    const parsed = parseSlashCommand(text);
    if (parsed === null) return;
    const cmdMatches = matchCommands(SLASH_COMMANDS, parsed.command);
    const match = cmdMatches[0];
    if (match !== undefined) {
      handleSlashSelect(match.command);
    }
  };

  const handleSubmit = (text: string): void => {
    if (text.trim() !== "") {
      // Add to history (deduplicate consecutive identical entries)
      const current = history();
      if (current[0] !== text) {
        setHistory((h: readonly string[]) => [text, ...h].slice(0, MAX_HISTORY));
      }
    }
    // Reset history navigation
    historyIdx = -1;
    draft = "";
    props.onSubmit(text);
  };

  /**
   * Navigate prompt history. The `currentText` parameter captures the
   * textarea contents at the moment navigation starts, so the user's
   * in-progress draft is preserved and restored on Down past index 0.
   */
  const handleHistoryNav = (
    direction: "up" | "down",
    currentText: string,
  ): string | null => {
    const h = history();
    if (h.length === 0) return null;

    if (direction === "up") {
      if (historyIdx < 0) {
        // Starting navigation — save the user's current draft
        draft = currentText;
        historyIdx = 0;
      } else if (historyIdx < h.length - 1) {
        historyIdx++;
      } else {
        return null; // Already at oldest
      }
      return h[historyIdx] ?? null;
    }
    // direction === "down"
    if (historyIdx < 0) return null; // Not navigating
    historyIdx--;
    if (historyIdx < 0) {
      return draft; // Return to saved draft
    }
    return h[historyIdx] ?? null;
  };

  const handleAtDetected = (query: string | null): void => {
    storeCtx?.dispatch({ kind: "set_at_query", query });
    if (query === null) {
      storeCtx?.dispatch({ kind: "set_at_results", results: [] });
    }
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <MessageList syntaxStyle={props.syntaxStyle} treeSitterClient={props.treeSitterClient} />
      {/* Checkpoint marker: a single-line hint above the input. Only renders
          once the user has submitted their first message so the empty
          conversation stays clean. One line tall = one extra row of vertical
          space when active. */}
      <Show when={hasCapturedTurn()}>
        <box paddingLeft={1} flexShrink={0}>
          <text fg={COLORS.textMuted}>↶ /rewind [n] to roll back previous turn(s)</text>
        </box>
      </Show>
      <InputArea
        onSubmit={handleSubmit}
        onSlashDetected={props.onSlashDetected}
        onSlashSubmit={handleSlashSubmit}
        onHistoryNav={handleHistoryNav}
        onAtDetected={handleAtDetected}
        onImageAttach={props.onImageAttach}
        focused={props.focused}
        // `disabled` is intentionally omitted here: InputArea's submit handler
        // already guards against slash-prefixed text synchronously via
        // detectSlashPrefix(), so the overlay can remain open while the user
        // continues typing to filter commands. Disabling the input would freeze
        // the query at the first "/" and break slash-command filtering.
        clearTrigger={clearTrigger()}
        atInsertPath={atInsertPath()}
      />
      {/* SlashOverlay is rendered after InputArea with position="absolute" so it
          floats just above the input without affecting the flex layout.
          bottom={3} matches the 3-row InputArea height. */}
      <Show when={slashQuery() !== null}>
        <box position="absolute" bottom={3} left={0} zIndex={10} backgroundColor={COLORS.bgElevated} >
          <SlashOverlay
            query={slashQuery() ?? ""}
            commands={SLASH_COMMANDS}
            onSelect={handleSlashSelect}
            onDismiss={dismissOverlay}
            focused={props.focused}
          />
        </box>
      </Show>
      {/* #10: AtOverlay for @-mention file completion */}
      <Show when={atQuery() !== null}>
        <box position="absolute" bottom={3} left={0} zIndex={10} backgroundColor={COLORS.bgElevated}>
          <AtOverlay
            query={atQuery() ?? ""}
            onSelect={handleAtSelect}
            onDismiss={dismissAtOverlay}
            focused={props.focused && slashQuery() === null}
          />
        </box>
      </Show>
    </box>
  );
}
