/**
 * StreamingIndicator — shows partially streamed assistant text.
 */

import { memo } from "react";
import Markdown from "react-markdown";

export const StreamingIndicator = memo(function StreamingIndicator({
  text,
}: {
  readonly text: string;
}): React.ReactElement {
  return (
    <div className="mt-3 ml-4 rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-3">
      <div className="prose prose-sm max-w-none dark:prose-invert text-sm">
        <Markdown>{text}</Markdown>
      </div>
      <span className="inline-block h-4 w-0.5 animate-pulse bg-[var(--color-primary)]" />
    </div>
  );
});
