/**
 * ThinkingBlock — renders the model's thinking/reasoning text.
 *
 * Displayed with dimmed styling to visually distinguish from
 * the assistant's direct response text.
 */

import type { JSX } from "solid-js";

interface ThinkingBlockProps {
  readonly text: string;
}

export function ThinkingBlock(props: ThinkingBlockProps): JSX.Element {
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text fg="gray">
        <i>{props.text}</i>
      </text>
    </box>
  );
}
