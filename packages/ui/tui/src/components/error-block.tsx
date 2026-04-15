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
  // Info-style rendering for non-error codes (e.g., /goal feedback)
  const isInfo = () => !props.block.code.includes("ERROR") && !props.block.code.includes("error");
  const color = () => (isInfo() ? "cyan" : "red");

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={color()}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color()}>
        <b>{isInfo() ? props.block.code : `Error: ${props.block.code}`}</b>
      </text>
      <text fg={color()}>{displayMessage()}</text>
    </box>
  );
}
