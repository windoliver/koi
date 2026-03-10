/**
 * TextViewer — renders plain text content with line numbers.
 * Supports "Lines" (table) and "Code" (CodeMirror) view modes.
 */

import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { CodeEditor } from "./code-editor.js";

type ViewMode = "lines" | "code";
type Language = "json" | "markdown" | "yaml" | "text";

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = {
  ".json": "json",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function detectLanguage(path: string): Language {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) {
    return "text";
  }
  const ext = path.slice(lastDot).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "text";
}

export function TextViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("lines");
  const lines = content.split("\n");
  const language = useMemo(() => detectLanguage(path), [path]);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded border border-[var(--color-border)] text-xs">
            <button
              type="button"
              onClick={() => setViewMode("lines")}
              className={`px-2 py-1 rounded-l ${
                viewMode === "lines"
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              }`}
            >
              Lines
            </button>
            <button
              type="button"
              onClick={() => setViewMode("code")}
              className={`px-2 py-1 rounded-r ${
                viewMode === "code"
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              }`}
            >
              Code
            </button>
          </div>
          <span className="text-xs text-[var(--color-muted)]">{lines.length} lines</span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {viewMode === "code" ? (
        <div className="flex-1 overflow-auto">
          <CodeEditor content={content} language={language} />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full font-mono text-sm">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-[var(--color-muted)]/5">
                  <td className="select-none border-r border-[var(--color-border)] px-3 py-0 text-right text-xs text-[var(--color-muted)]">
                    {i + 1}
                  </td>
                  <td className="px-3 py-0 whitespace-pre-wrap break-all">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
