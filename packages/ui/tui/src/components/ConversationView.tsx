/**
 * ConversationView — the "conversation" screen (activeView === "conversation").
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { COMMAND_DEFINITIONS } from "../commands/command-definitions.js";
import type { SlashCommand } from "../commands/slash-detection.js";
import { useTuiStore } from "../store-context.js";
import { InputArea } from "./InputArea.js";
import { MessageList } from "./message-list.js";
import { SlashOverlay } from "./SlashOverlay.js";

const SLASH_COMMANDS: readonly SlashCommand[] = COMMAND_DEFINITIONS.map((cmd) => ({
  name: cmd.id.split(":")[1] ?? cmd.id,
  description: cmd.description,
}));

export interface ConversationViewProps {
  readonly onSubmit: (text: string) => void;
  readonly onSlashDetected: (query: string | null) => void;
  readonly onSlashSelect?: ((command: SlashCommand) => void) | undefined;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function ConversationView(props: ConversationViewProps): JSX.Element {
  const slashQuery = useTuiStore((s) => s.slashQuery);
  // Incremented on every slash-command selection to clear the textarea text
  const [clearTrigger, setClearTrigger] = createSignal(0);

  const dismissOverlay = (): void => {
    props.onSlashDetected(null);
  };

  const handleSlashSelect = (command: SlashCommand): void => {
    props.onSlashDetected(null);
    setClearTrigger((n) => n + 1);
    props.onSlashSelect?.(command);
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <MessageList syntaxStyle={props.syntaxStyle} />
      <Show when={slashQuery() !== null}>
        <SlashOverlay
          query={slashQuery() ?? ""}
          commands={SLASH_COMMANDS}
          onSelect={handleSlashSelect}
          onDismiss={dismissOverlay}
          focused={props.focused}
        />
      </Show>
      <InputArea
        onSubmit={props.onSubmit}
        onSlashDetected={props.onSlashDetected}
        focused={props.focused}
        // `disabled` is intentionally omitted here: InputArea's submit handler
        // already guards against slash-prefixed text synchronously via
        // detectSlashPrefix(), so the overlay can remain open while the user
        // continues typing to filter commands. Disabling the input would freeze
        // the query at the first "/" and break slash-command filtering.
        clearTrigger={clearTrigger()}
      />
    </box>
  );
}
