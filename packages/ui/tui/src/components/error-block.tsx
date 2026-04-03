/**
 * ErrorBlock — renders an error with code and message.
 *
 * Styled with red border and prominent text to distinguish
 * errors from normal conversation flow.
 */

import type { ReactNode } from "react";
import type { TuiAssistantBlock } from "../state/types.js";

type ErrorData = TuiAssistantBlock & { readonly kind: "error" };

interface ErrorBlockProps {
  readonly block: ErrorData;
}

export function ErrorBlock({ block }: ErrorBlockProps): ReactNode {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor="red"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="red">
        <b>Error: {block.code}</b>
      </text>
      <text fg="red">{block.message}</text>
    </box>
  );
}
