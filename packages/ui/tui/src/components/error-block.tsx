/**
 * ErrorBlock — renders an error with code and unwrapped message.
 *
 * Deep-parses JSON error responses (double-encoded, nested .error.message)
 * for clean human-readable display (Decision 4.1).
 */

import type { JSX } from "solid-js";
import type { TuiAssistantBlock } from "../state/types.js";
import { unwrapErrorMessage } from "../utils/unwrap-error.js";

type ErrorData = TuiAssistantBlock & { readonly kind: "error" };

interface ErrorBlockProps {
  readonly block: ErrorData;
}

export function ErrorBlock(props: ErrorBlockProps): JSX.Element {
  const displayMessage = () => unwrapErrorMessage(props.block.message);

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
      <text fg="red">{displayMessage()}</text>
    </box>
  );
}
