/**
 * Console view — chat interface for interacting with a single agent.
 *
 * Renders chat history as markdown blocks and provides an editor input
 * at the bottom for sending messages. Streaming text is shown as a
 * live-updating markdown block.
 */

import {
  Container,
  Editor,
  type EditorTheme,
  Markdown,
  Spacer,
  Text,
  type TUI,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { ChatMessage, SessionState } from "../state/types.js";
import { KOI_MARKDOWN_THEME, KOI_SELECT_THEME } from "../theme.js";

/** Maximum chat history lines to render (prevents unbounded rendering). */
const MAX_RENDERED_MESSAGES = 50;

/** Callbacks for console interactions. */
export interface ConsoleCallbacks {
  readonly onSendMessage: (text: string) => void;
  readonly onEscape: () => void;
}

/** Editor theme for the input bar. */
const EDITOR_THEME: EditorTheme = {
  borderColor: (s: string) => chalk.cyan(s),
  selectList: KOI_SELECT_THEME,
};

/** Render a single chat message as styled text lines. */
function renderMessage(msg: ChatMessage): string {
  switch (msg.kind) {
    case "user":
      return `**You:** ${msg.text}`;
    case "assistant":
      return msg.text;
    case "tool_call":
      return `\`${msg.name}\`(${msg.args})${msg.result !== undefined ? ` → ${msg.result}` : ""}`;
    case "lifecycle":
      return `*${msg.event}*`;
  }
}

/** Create the console view for agent chat. */
export function createConsoleView(
  tui: TUI,
  callbacks: ConsoleCallbacks,
): {
  readonly container: Container;
  readonly editor: Editor;
  readonly update: (session: SessionState | null) => void;
} {
  const container = new Container();
  const chatArea = new Container();
  const inputSpacer = new Spacer(1);
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });

  container.addChild(chatArea);
  container.addChild(inputSpacer);
  container.addChild(editor);

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed !== "") {
      callbacks.onSendMessage(trimmed);
      editor.setText("");
    }
  };

  // Track previous message count to avoid re-rendering unchanged history
  let prevMessageCount = 0;
  let prevPendingText = "";

  function update(session: SessionState | null): void {
    if (session === null) {
      chatArea.clear();
      chatArea.addChild(new Text(chalk.dim("No active session"), 1, 1));
      chatArea.invalidate();
      return;
    }

    const { messages, pendingText } = session;

    // Only rebuild if messages or pending text changed
    if (messages.length === prevMessageCount && pendingText === prevPendingText) {
      return;
    }
    prevMessageCount = messages.length;
    prevPendingText = pendingText;

    chatArea.clear();

    // Render recent messages (tail of sliding window)
    const recentMessages = messages.slice(-MAX_RENDERED_MESSAGES);
    for (const msg of recentMessages) {
      const mdText = renderMessage(msg);
      const md = new Markdown(mdText, 1, 0, KOI_MARKDOWN_THEME);
      chatArea.addChild(md);
      chatArea.addChild(new Spacer(1));
    }

    // Render streaming pending text
    if (pendingText !== "") {
      const streamingMd = new Markdown(pendingText, 1, 0, KOI_MARKDOWN_THEME);
      chatArea.addChild(streamingMd);
      chatArea.addChild(new Spacer(1));
    }

    chatArea.invalidate();
  }

  return { container, editor, update };
}
