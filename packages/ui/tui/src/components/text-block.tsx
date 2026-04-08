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
 * - No-fence streaming: when there's no unclosed fence, the full text
 *   is healed and rendered with streaming={true} to avoid finalizing
 *   partial inline markdown (bold, links, inline code).
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

  // Whether there's an actual fence-based split (tail is non-empty)
  const hasFenceSplit = () => split().tail !== "";

  // Heal content for streaming display (Decision 2A):
  // - With fence split: heal only the tail (stable head is already complete)
  // - Without fence split: heal the full text (partial bold/links/inline code)
  const healedContent = createMemo(() => {
    if (!props.streaming) return "";
    if (hasFenceSplit()) return healMarkdown(split().tail);
    // No fence — heal the full text for streaming display
    return healMarkdown(props.text);
  });

  return (
    <Show
      when={markdownConfig()}
      fallback={<text>{props.text}</text>}
    >
      {(cfg: () => MarkdownConfig) => (
        <Show
          when={props.streaming && (hasFenceSplit() || props.text !== "")}
          fallback={
            // Non-streaming: render full text as single finalized markdown
            <markdown
              content={props.text}
              syntaxStyle={cfg().style}
              treeSitterClient={cfg().client}
              streaming={false}
            />
          }
        >
          {/* Streaming path */}
          <box flexDirection="column">
            {/* With fence split: stable head (memoized, finalized) + healed tail */}
            <Show when={hasFenceSplit() && split().stable !== ""}>
              <markdown
                content={split().stable}
                syntaxStyle={cfg().style}
                treeSitterClient={cfg().client}
                streaming={false}
              />
            </Show>
            {/* Healed content — either tail-only (fence split) or full text (no fence) */}
            <Show when={healedContent() !== ""}>
              <markdown
                content={healedContent()}
                syntaxStyle={cfg().style}
                treeSitterClient={cfg().client}
                streaming={true}
              />
            </Show>
          </box>
        </Show>
      )}
    </Show>
  );
}
