/**
 * MessageList — scrollable conversation display.
 *
 * A single global spinnerFrame signal drives all ToolCallBlock spinners in sync.
 * The signal is passed as an Accessor<number> (not a resolved number) so only the
 * leaf StatusIndicator component subscribes — MessageRow and AssistantBlock are
 * not reactive to frame ticks.
 *
 * The spinner interval is paused when no tool calls are in the "running" state,
 * eliminating idle timer overhead (12.5 noop updates/second at idle).
 *
 * TODO: Consider OpenTUI scrollbox virtualization for very large conversations
 * (>1000 messages). First verify whether scrollbox frame diffing already avoids
 * re-rendering off-screen rows at the renderer level before adding complexity.
 * The MAX_MESSAGES compaction cap bounds the worst case for now.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { createEffect, createSignal, For, onCleanup } from "solid-js";
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

  // Derive whether any tool call is currently running. The interval only fires
  // when there is visible work to animate, eliminating idle overhead.
  const hasRunningTools = useTuiStore((s) =>
    s.messages.some(
      (m) =>
        m.kind === "assistant" &&
        m.blocks.some((b) => b.kind === "tool_call" && b.status === "running"),
    ),
  );

  createEffect(() => {
    if (!hasRunningTools()) return;
    const id = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAME_COUNT),
      SPINNER_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  return (
    <scrollbox flexGrow={1} stickyScroll>
      <box flexDirection="column" gap={1}>
        <For each={messages()}>
          {(msg) => (
            <MessageRow
              message={msg}
              syntaxStyle={props.syntaxStyle}
              spinnerFrame={spinnerFrame}
            />
          )}
        </For>
      </box>
    </scrollbox>
  );
}
