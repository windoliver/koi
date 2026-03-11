/**
 * ActiveToolCallIndicator — shows in-progress tool calls.
 *
 * Renders each active tool call with a spinner and accumulated args,
 * giving visibility into long-running or streaming tool invocations.
 */

import { Loader2, Wrench } from "lucide-react";
import { memo } from "react";

interface ActiveToolCallProps {
  readonly toolCalls: Readonly<
    Record<string, { readonly name: string; readonly args: string }>
  >;
}

/** Format accumulated args for display (truncate if long). */
function formatArgs(args: string): string {
  if (args === "") return "...";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // Partial JSON — show raw (truncated)
    return args.length > 200 ? `${args.slice(0, 200)}...` : args;
  }
}

export const ActiveToolCallIndicator = memo(function ActiveToolCallIndicator({
  toolCalls,
}: ActiveToolCallProps): React.ReactElement | null {
  const entries = Object.entries(toolCalls);
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {entries.map(([id, tc]) => (
        <div
          key={id}
          className="ml-8 rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-2"
        >
          <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            <Wrench className="h-3 w-3" />
            <span className="font-mono font-medium">{tc.name}</span>
            <span className="italic">running...</span>
          </div>
          {tc.args !== "" && (
            <pre className="mt-1 max-h-24 overflow-auto rounded bg-[var(--color-muted)]/10 p-2 font-mono text-xs">
              {formatArgs(tc.args)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
});
