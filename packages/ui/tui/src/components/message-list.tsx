/**
 * MessageList — scrollable conversation display.
 * A single global spinnerFrame signal drives all ToolCallBlock spinners in sync.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { createSignal, For, onCleanup } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { MessageRow } from "./message-row.js";

const SPINNER_FRAME_COUNT = 10;
const SPINNER_INTERVAL_MS = 80;

interface MessageListProps {
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const messages = useTuiStore((s) => s.messages);
  const [spinnerFrame, setSpinnerFrame] = createSignal(0);
  const intervalId = setInterval(
    () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAME_COUNT),
    SPINNER_INTERVAL_MS,
  );
  onCleanup(() => clearInterval(intervalId));

  return (
    <scrollbox flexGrow={1} stickyScroll>
      <box flexDirection="column" gap={1}>
        <For each={messages()}>
          {(msg) => (
            <MessageRow
              message={msg}
              syntaxStyle={props.syntaxStyle}
              spinnerFrame={spinnerFrame()}
            />
          )}
        </For>
      </box>
    </scrollbox>
  );
}
