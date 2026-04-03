/**
 * TextBlock — renders a text block.
 *
 * Uses <text> for reliable baseline rendering. When syntaxStyle is provided
 * (indicating tree-sitter is available), upgrades to <markdown> for rich
 * rendering with syntax-highlighted code fences.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { ReactNode } from "react";

interface TextBlockProps {
  readonly text: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function TextBlock({ text, syntaxStyle }: TextBlockProps): ReactNode {
  if (syntaxStyle !== undefined) {
    return <markdown content={text} syntaxStyle={syntaxStyle} />;
  }
  return <text>{text}</text>;
}
