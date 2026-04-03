/**
 * ThinkingBlock — renders the model's thinking/reasoning text.
 *
 * Displayed with dimmed styling to visually distinguish from
 * the assistant's direct response text.
 */

import type { ReactNode } from "react";

interface ThinkingBlockProps {
  readonly text: string;
}

export function ThinkingBlock({ text }: ThinkingBlockProps): ReactNode {
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text fg="gray">
        <i>{text}</i>
      </text>
    </box>
  );
}
