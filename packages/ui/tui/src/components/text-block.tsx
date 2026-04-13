/**
 * TextBlock — renders a text block with streaming-aware markdown.
 *
 * Uses <text> for reliable baseline rendering. When syntaxStyle is provided,
 * upgrades to <markdown> for rich rendering with syntax-highlighted code
 * fences and full prose/heading support. The <markdown> renderable auto-
 * initializes a TreeSitterClient singleton via getTreeSitterClient() — no
 * explicit treeSitterClient prop is needed (same pattern as opencode).
 *
 * If the embedding environment doesn't have OpenTUI's tree-sitter runtime
 * available, pass `syntaxStyle={undefined}` to force plain-text fallback.
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

import type { Renderable, SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { healMarkdown } from "../streaming/heal-markdown.js";
import { splitStreamingMarkdown } from "../streaming/split-streaming-markdown.js";

/** Enable text selection on a renderable. MarkdownRenderable inherits
 *  selectable=false from Renderable; OpenTUI's typed props don't expose
 *  `selectable` on `<markdown>`, so we set it imperatively via ref. */
function enableSelection(el: Renderable | null): void {
  if (el) el.selectable = true;
}

interface TextBlockProps {
  readonly text: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly streaming?: boolean | undefined;
}

export function TextBlock(props: TextBlockProps): JSX.Element {
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
    <Show when={props.syntaxStyle} fallback={<text selectable>{props.text}</text>}>
      {(style: () => SyntaxStyle) => (
        <Show
          when={props.streaming && (hasFenceSplit() || props.text !== "")}
          fallback={
            // Non-streaming: render full text as single finalized markdown
            <markdown
              ref={enableSelection}
              content={props.text}
              syntaxStyle={style()}
              streaming={false}
            />
          }
        >
          {/* Streaming path */}
          <box flexDirection="column">
            {/* With fence split: stable head (memoized, finalized) + healed tail */}
            <Show when={hasFenceSplit() && split().stable !== ""}>
              <markdown
                ref={enableSelection}
                content={split().stable}
                syntaxStyle={style()}
                streaming={false}
              />
            </Show>
            {/* Healed content — either tail-only (fence split) or full text (no fence) */}
            <Show when={healedContent() !== ""}>
              <markdown
                ref={enableSelection}
                content={healedContent()}
                syntaxStyle={style()}
                streaming={true}
              />
            </Show>
          </box>
        </Show>
      )}
    </Show>
  );
}
