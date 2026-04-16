/**
 * InfoBlock — renders an informational message with neutral styling.
 * Used by /goal and other non-error slash command feedback.
 */

import type { JSX } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";

type InfoData = TuiAssistantBlock & { readonly kind: "info" };

interface InfoBlockProps {
  readonly block: InfoData;
}

export function InfoBlock(props: InfoBlockProps): JSX.Element {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor="cyan"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="cyan">{props.block.message}</text>
    </box>
  );
}
