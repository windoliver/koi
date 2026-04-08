/**
 * MessageList — scrollable conversation display with auto-scroll.
 *
 * A single global spinnerFrame signal drives all ToolCallBlock spinners in sync.
 * The signal is passed as an Accessor<number> (not a resolved number) so only the
 * leaf StatusIndicator component subscribes — MessageRow and AssistantBlock are
 * not reactive to frame ticks.
 *
 * The spinner interval is paused when no tool calls are in the "running" state,
 * eliminating idle timer overhead (12.5 noop updates/second at idle).
 *
 * Auto-scroll (Decisions 6-8, 7A):
 * - Scroll-up pauses auto-follow
 * - Text selection pauses auto-follow
 * - 300ms settling period after streaming ends
 * - Keyboard scroll (PageUp/PageDown) pauses auto-follow
 * - Terminal resize re-engages following
 */

import type { SyntaxStyle, TreeSitterClient } from "@opentui/core";
import { onResize, useKeyboard, useSelectionHandler } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createEffect, createSignal, For, on, onCleanup } from "solid-js";
import {
  INITIAL_SCROLL_STATE,
  SETTLE_DURATION_MS,
  onScrollToBottom,
  onScrollUp,
  onSelectionEnd,
  onSelectionStart,
  onSettleTimeout,
  onStreamEnd,
  shouldFollow,
} from "../auto-scroll/auto-scroll-state.js";
import { useTuiStore } from "../store-context.js";
import { MessageRow } from "./message-row.js";

const SPINNER_FRAME_COUNT = 10;
const SPINNER_INTERVAL_MS = 80;

interface MessageListProps {
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const messages = useTuiStore((s) => s.messages);
  const [spinnerFrame, setSpinnerFrame] = createSignal(0);

  // Spinner ticks when tools are running OR agent is processing (thinking indicator).
  const hasRunningTools = useTuiStore((s) => s.runningToolCount > 0);
  const isProcessing = useTuiStore((s) => s.agentStatus === "processing");
  const needsSpinner = () => hasRunningTools() || isProcessing();

  createEffect(() => {
    if (!needsSpinner()) return;
    const id = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAME_COUNT),
      SPINNER_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  // ── Auto-scroll state machine (Decisions 6-8, 7A) ────────────────────────
  const [scrollState, setScrollState] = createSignal(INITIAL_SCROLL_STATE);
  const agentStatus = useTuiStore((s) => s.agentStatus);
  const messageCount = useTuiStore((s) => s.messages.length);

  // Reset scroll state on session clear/resume (messages drop to 0).
  // Without this, a user who scrolled up in session A stays paused in session B.
  createEffect(
    on(messageCount, (count: number, prev: number | undefined) => {
      if (count === 0 && prev !== undefined && prev > 0) {
        setScrollState(INITIAL_SCROLL_STATE);
      }
    }),
  );

  // Detect streaming end → settling period (only if not user-paused)
  createEffect(
    on(agentStatus, (status, prevStatus) => {
      if (prevStatus === "processing" && status === "idle") {
        setScrollState((prev) => {
          const next = onStreamEnd(prev, Date.now());
          // Only schedule settle timer if we actually entered settling mode.
          // If onStreamEnd preserved a user pause, no timer — stay paused.
          if (next.mode === "settling") {
            const timer = setTimeout(() => {
              setScrollState((s) => (s.mode === "settling" ? onSettleTimeout(s) : s));
            }, SETTLE_DURATION_MS);
            onCleanup(() => clearTimeout(timer));
          }
          return next;
        });
      }
    }),
  );

  // Keyboard scroll detection (Decision 7A) — PageUp/PageDown only.
  // Ctrl+Up/Down are NOT used here because InputArea's useKeyboard is always
  // focused in conversation view and would shadow those keys.
  useKeyboard((key) => {
    if (key.name === "pageup") {
      setScrollState((s) => onScrollUp(s));
    }
    if (key.name === "pagedown") {
      setScrollState((s) => onScrollToBottom(s));
    }
  });

  // Terminal resize re-engages following (Decision 7A)
  onResize(() => {
    setScrollState(INITIAL_SCROLL_STATE);
  });

  // Text selection pauses auto-scroll
  useSelectionHandler((selection) => {
    if (selection !== null && selection !== undefined) {
      setScrollState((s) => onSelectionStart(s));
    } else {
      setScrollState((s) => onSelectionEnd(s));
    }
  });

  // Ref for scroll position detection — only resume follow when actually at bottom
  // `let` justified: mutable ref assigned by JSX ref callback
  let scrollboxRef: { readonly scrollTop: number; readonly scrollHeight: number; readonly height: number } | null = null;

  /** Check if viewport is within 5px of the bottom edge. */
  const isAtBottom = (): boolean => {
    if (!scrollboxRef) return true; // assume bottom if no ref yet
    const bottom = scrollboxRef.scrollTop + scrollboxRef.height;
    return scrollboxRef.scrollHeight - bottom < 5;
  };

  return (
    <scrollbox
      ref={(el: typeof scrollboxRef) => { scrollboxRef = el; }}
      flexGrow={1}
      stickyScroll={shouldFollow(scrollState())}
      stickyStart="bottom"
      onMouseScroll={(event) => {
        // MouseEvent.y is the vertical scroll position; negative = scroll up
        const deltaY = "deltaY" in event ? (event as { readonly deltaY: number }).deltaY : event.y;
        if (deltaY < 0) {
          setScrollState((s) => onScrollUp(s));
        } else if (isAtBottom()) {
          setScrollState((s) => onScrollToBottom(s));
        }
      }}
    >
      <box flexDirection="column" gap={1}>
        <For each={messages()}>
          {(msg) => (
            <MessageRow
              message={msg}
              syntaxStyle={props.syntaxStyle}
              treeSitterClient={props.treeSitterClient}
              spinnerFrame={spinnerFrame}
            />
          )}
        </For>
      </box>
    </scrollbox>
  );
}
