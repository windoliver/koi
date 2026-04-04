/**
 * ErrorBlock — renders an error with code and message.
 *
 * Styled with red border and prominent text to distinguish
 * errors from normal conversation flow.
 */

import type { JSX } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";

type ErrorData = TuiAssistantBlock & { readonly kind: "error" };

interface ErrorBlockProps {
  readonly block: ErrorData;
}

export function ErrorBlock(props: ErrorBlockProps): JSX.Element {
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
        <b>Error: {props.block.code}</b>
      </text>
      <text fg="red">{props.block.message}</text>
    </box>
  );
}
