/**
 * PendingFramesViewer — renders pending interaction frames.
 *
 * Each frame shows type, status, and a content preview.
 */

import { Inbox } from "lucide-react";

interface PendingFrame {
  readonly type?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

const STATUS_COLORS: Readonly<Record<string, string>> = {
  pending: "bg-yellow-500/10 text-yellow-600",
  processing: "bg-blue-500/10 text-blue-600",
  completed: "bg-green-500/10 text-green-600",
  failed: "bg-red-500/10 text-red-600",
};

function statusColorClass(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]";
}

function contentPreview(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") {
    return content.length > 120 ? `${content.slice(0, 120)}...` : content;
  }
  const json = JSON.stringify(content);
  return json.length > 120 ? `${json.slice(0, 120)}...` : json;
}

export function PendingFramesViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let frames: readonly PendingFrame[];
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      frames = parsed as readonly PendingFrame[];
    } else if (typeof parsed === "object" && parsed !== null && "frames" in parsed) {
      const obj = parsed as Record<string, unknown>;
      frames = Array.isArray(obj.frames) ? (obj.frames as readonly PendingFrame[]) : [];
    } else {
      frames = [];
    }
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse pending frames: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Inbox className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <span className="text-xs text-[var(--color-muted)]">{frames.length} frames</span>
      </div>
      <div className="flex-1 overflow-auto">
        {frames.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]/50">
            {frames.map((frame, i) => (
              <div key={i} className="px-4 py-3 hover:bg-[var(--color-muted)]/5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {frame.type ?? frame.kind ?? `Frame #${i}`}
                  </span>
                  {frame.status !== undefined && (
                    <span className={`rounded px-2 py-0.5 text-xs ${statusColorClass(frame.status)}`}>
                      {frame.status}
                    </span>
                  )}
                </div>
                {frame.content !== undefined && (
                  <div className="mt-1 truncate font-mono text-xs text-[var(--color-muted)]">
                    {contentPreview(frame.content)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
            No pending frames
          </div>
        )}
      </div>
    </div>
  );
}
