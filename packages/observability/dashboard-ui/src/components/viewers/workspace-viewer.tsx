/**
 * WorkspaceViewer — renders agent workspace files (scratch, artifacts).
 *
 * For JSON files, renders as structured data. For text files, renders
 * with line numbers.
 */

import { FolderCode } from "lucide-react";
import { JsonViewer } from "./json-viewer.js";
import { TextViewer } from "./text-viewer.js";

function isJsonContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function WorkspaceViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  // Workspace files can be any format — detect and delegate
  if (isJsonContent(content)) {
    return <JsonViewer content={content} path={path} />;
  }

  // Check if it's a known text format
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "txt" || ext === "log" || ext === "yaml" || ext === "yml" || ext === "toml") {
    return <TextViewer content={content} path={path} />;
  }

  // Default: show with workspace header + text content
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <FolderCode className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
      </div>
      <div className="flex-1 overflow-auto p-4 whitespace-pre-wrap font-mono text-sm">
        {content}
      </div>
    </div>
  );
}
