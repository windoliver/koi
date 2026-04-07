/**
 * TextBlock — renders a text block with streaming-aware markdown.
 *
 * Uses <text> for reliable baseline rendering. When both syntaxStyle and
 * treeSitterClient are provided, upgrades to <markdown> for rich rendering
 * with syntax-highlighted code fences and full prose/heading support.
 *
 * Streaming optimizations (Decisions 3A, 2A):
 * - Code block isolation: splits text at the last unclosed fence so the
 *   stable head is memoized and only the live tail is re-parsed.
 * - Markdown healing: closes unclosed formatting marks so partial
 *   markdown renders correctly during streaming.
 */

import type { SyntaxStyle, TreeSitterClient } from "@opentui/core";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { healMarkdown } from "../streaming/heal-markdown.js";
import { splitStreamingMarkdown } from "../streaming/split-streaming-markdown.js";

interface TextBlockProps {
  readonly text: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
  readonly streaming?: boolean | undefined;
}

type MarkdownConfig = { readonly style: SyntaxStyle; readonly client: TreeSitterClient };

export function TextBlock(props: TextBlockProps): JSX.Element {
  const markdownConfig = (): MarkdownConfig | undefined => {
    if (props.syntaxStyle !== undefined && props.treeSitterClient !== undefined) {
      return { style: props.syntaxStyle, client: props.treeSitterClient };
    }
    return undefined;
  };

  // Streaming code block isolation (Decision 3A):
  // Split at the last unclosed fence. The stable part is memoized — only
  // the tail (which changes on every delta) triggers a re-parse.
  const split = createMemo(() => {
    if (!props.streaming) return { stable: props.text, tail: "" };
    return splitStreamingMarkdown(props.text);
  });

  // Heal the tail for display (Decision 2A):
  // Close unclosed formatting so partial markdown renders correctly.
  const healedTail = createMemo(() => {
    const tail = split().tail;
    if (tail === "") return "";
    return healMarkdown(tail);
  });

  return (
    <Show
      when={markdownConfig()}
      fallback={<text>{props.text}</text>}
    >
      {(cfg: () => MarkdownConfig) => (
        <box flexDirection="column">
          {/* Stable head — memoized, not re-parsed during streaming */}
          <Show when={split().stable !== ""}>
            <markdown
              content={split().stable}
              syntaxStyle={cfg().style}
              treeSitterClient={cfg().client}
              streaming={false}
            />
          </Show>
          {/* Live tail — re-parsed on each delta, healed for display */}
          <Show when={healedTail() !== ""}>
            <markdown
              content={healedTail()}
              syntaxStyle={cfg().style}
              treeSitterClient={cfg().client}
              streaming={props.streaming ?? false}
            />
          </Show>
          {/* Non-streaming: render full text as single markdown */}
          <Show when={!props.streaming && split().tail === ""}>
            {/* This case is handled by stable above when not streaming */}
          </Show>
        </box>
      )}
    </Show>
  );
}
