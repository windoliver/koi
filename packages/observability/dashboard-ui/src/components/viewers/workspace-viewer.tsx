/**
 * WorkspaceViewer — renders agent workspace files (scratch, artifacts).
 *
 * For JSON files, renders as structured data. For text files, renders
 * with line numbers. When the file is editable, shows a CodeEditor in
 * edit mode with save support.
 */

import { useCallback, useState } from "react";
import { FolderCode, Pencil, Eye } from "lucide-react";
import { saveFile } from "../../lib/api-client.js";
import { CodeEditor } from "./code-editor.js";
import { JsonViewer } from "./json-viewer.js";
import { TextViewer } from "./text-viewer.js";

type Language = "json" | "markdown" | "yaml" | "text";

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = {
  ".json": "json",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function detectLanguage(path: string): Language {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "text";
  const ext = path.slice(lastDot).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "text";
}

function isJsonContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function WorkspaceViewer({
  content,
  path,
  editable = false,
}: {
  readonly content: string;
  readonly path: string;
  readonly editable?: boolean;
}): React.ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const handleSave = useCallback(
    (newContent: string) => {
      setSaveStatus("saving");
      saveFile(path, newContent)
        .then(() => {
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2000);
        })
        .catch(() => {
          setSaveStatus("error");
          setTimeout(() => setSaveStatus("idle"), 3000);
        });
    },
    [path],
  );

  // Editing mode — always use CodeEditor for editing
  if (editable && isEditing) {
    const language = detectLanguage(path);
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <div className="flex items-center gap-2">
            <FolderCode className="h-4 w-4 text-[var(--color-muted)]" />
            <span className="text-sm font-medium">{path.split("/").pop()}</span>
          </div>
          <div className="flex items-center gap-2">
            {saveStatus === "saved" && (
              <span className="text-xs text-green-500">Saved</span>
            )}
            {saveStatus === "saving" && (
              <span className="text-xs text-[var(--color-muted)]">Saving...</span>
            )}
            {saveStatus === "error" && (
              <span className="text-xs text-red-500">Save failed</span>
            )}
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            >
              <Eye className="h-3.5 w-3.5" />
              View
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          <CodeEditor content={content} language={language} editable onSave={handleSave} />
        </div>
      </div>
    );
  }

  // Read-only view — delegate to appropriate viewer
  const editButton = editable ? (
    <button
      type="button"
      onClick={() => setIsEditing(true)}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
    >
      <Pencil className="h-3.5 w-3.5" />
      Edit
    </button>
  ) : null;

  if (isJsonContent(content)) {
    return (
      <div className="flex flex-col h-full">
        {editButton !== null && (
          <div className="flex justify-end border-b border-[var(--color-border)] px-4 py-2">
            {editButton}
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <JsonViewer content={content} path={path} />
        </div>
      </div>
    );
  }

  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "txt" || ext === "log" || ext === "yaml" || ext === "yml" || ext === "toml") {
    return (
      <div className="flex flex-col h-full">
        {editButton !== null && (
          <div className="flex justify-end border-b border-[var(--color-border)] px-4 py-2">
            {editButton}
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <TextViewer content={content} path={path} />
        </div>
      </div>
    );
  }

  // Default: show with workspace header + text content
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <FolderCode className="h-4 w-4 text-[var(--color-muted)]" />
          <span className="text-sm font-medium">{path.split("/").pop()}</span>
        </div>
        {editButton}
      </div>
      <div className="flex-1 overflow-auto p-4 whitespace-pre-wrap font-mono text-sm">
        {content}
      </div>
    </div>
  );
}
