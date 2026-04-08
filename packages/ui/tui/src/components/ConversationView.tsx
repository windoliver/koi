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
import { createEffect, createSignal, on, Show } from "solid-js";
import { COMMAND_DEFINITIONS } from "../commands/command-definitions.js";
import type { SlashCommand } from "../commands/slash-detection.js";
import { useTuiStore } from "../store-context.js";
import { COLORS } from "../theme.js";
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
  readonly onSlashSelect?: ((command: SlashCommand) => void) | undefined;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
}

export function ConversationView(props: ConversationViewProps): JSX.Element {
  const slashQuery = useTuiStore((s) => s.slashQuery);
  // Incremented on every slash-command selection to clear the textarea text
  const [clearTrigger, setClearTrigger] = createSignal(0);

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

  const handleSlashSelect = (command: SlashCommand): void => {
    props.onSlashDetected(null);
    setClearTrigger((n: number) => n + 1);
    props.onSlashSelect?.(command);
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

  return (
    <box flexDirection="column" flexGrow={1}>
      <MessageList syntaxStyle={props.syntaxStyle} treeSitterClient={props.treeSitterClient} />
      <InputArea
        onSubmit={handleSubmit}
        onSlashDetected={props.onSlashDetected}
        onHistoryNav={handleHistoryNav}
        focused={props.focused}
        // `disabled` is intentionally omitted here: InputArea's submit handler
        // already guards against slash-prefixed text synchronously via
        // detectSlashPrefix(), so the overlay can remain open while the user
        // continues typing to filter commands. Disabling the input would freeze
        // the query at the first "/" and break slash-command filtering.
        clearTrigger={clearTrigger()}
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
    </box>
  );
}
