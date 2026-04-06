/**
 * TextBlock — renders a text block.
 *
 * Uses <text> for reliable baseline rendering. When both syntaxStyle and
 * treeSitterClient are provided, upgrades to <markdown> for rich rendering
 * with syntax-highlighted code fences and full prose/heading support.
 *
 * The streaming prop prevents <markdown> from finalizing incomplete syntax
 * (e.g., unclosed backtick fences) during LLM streaming. Set streaming=true
 * while the message is still receiving deltas; false (default) when complete.
 */

import type { SyntaxStyle, TreeSitterClient } from "@opentui/core";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

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

  return (
    <Show
      when={markdownConfig()}
      fallback={<text>{props.text}</text>}
    >
      {(cfg: () => MarkdownConfig) => (
        <markdown
          content={props.text}
          syntaxStyle={cfg().style}
          treeSitterClient={cfg().client}
          streaming={props.streaming ?? false}
        />
      )}
    </Show>
  );
}
