/**
 * ScratchpadViewer — renders scratchpad directory files.
 *
 * Groups related files by prefix and shows them in sections. Falls back
 * to plain text/JSON viewer based on content.
 */

import { FileText } from "lucide-react";
import { JsonViewer } from "./json-viewer.js";
import { TextViewer } from "./text-viewer.js";

interface ScratchpadData {
  readonly entries?: readonly ScratchpadEntry[];
  readonly [key: string]: unknown;
}

interface ScratchpadEntry {
  readonly name?: string;
  readonly path?: string;
  readonly content?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

function isJsonContent(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function groupByPrefix(entries: readonly ScratchpadEntry[]): ReadonlyMap<string, readonly ScratchpadEntry[]> {
  const groups = new Map<string, ScratchpadEntry[]>();
  for (const entry of entries) {
    const name = entry.name ?? entry.path ?? "";
    // Group by the part before the first dot or dash
    const match = /^([a-zA-Z0-9_]+)/.exec(name);
    const prefix = (match !== null ? match[1] : undefined) ?? "other";
    const existing = groups.get(prefix);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      groups.set(prefix, [entry]);
    }
  }
  return groups;
}

export function ScratchpadViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  // Try to parse as structured scratchpad data
  let data: ScratchpadData | null = null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && "entries" in parsed) {
      data = parsed as ScratchpadData;
    }
  } catch {
    // Not JSON — fall through to content-based detection
  }

  // If structured scratchpad with entries, render grouped view
  if (data !== null && data.entries !== undefined && data.entries.length > 0) {
    const groups = groupByPrefix(data.entries);

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <FileText className="h-4 w-4 text-[var(--color-muted)]" />
          <span className="text-sm font-medium">{path.split("/").pop()}</span>
          <span className="text-xs text-[var(--color-muted)]">
            {data.entries.length} entries
          </span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {[...groups.entries()].map(([prefix, entries]) => (
            <div key={prefix} className="mb-4">
              <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)] uppercase">
                {prefix}
              </h3>
              <div className="divide-y divide-[var(--color-border)]/50 rounded-lg border border-[var(--color-border)]">
                {entries.map((entry, i) => (
                  <div key={entry.name ?? i} className="px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{entry.name ?? `entry-${i}`}</span>
                      {entry.type !== undefined && (
                        <span className="rounded bg-[var(--color-muted)]/10 px-1.5 py-0.5 text-[var(--color-muted)]">
                          {entry.type}
                        </span>
                      )}
                    </div>
                    {entry.content !== undefined && (
                      <div className="mt-1 truncate font-mono text-xs text-[var(--color-muted)]">
                        {entry.content.length > 200
                          ? `${entry.content.slice(0, 200)}...`
                          : entry.content}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Fall back to JSON or text viewer based on content
  if (isJsonContent(content)) {
    return <JsonViewer content={content} path={path} />;
  }

  return <TextViewer content={content} path={path} />;
}
