/**
 * JsonViewer — renders JSON content with syntax highlighting and collapsible sections.
 * Supports "Tree" (collapsible) and "Code" (CodeMirror) view modes.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { CodeEditor } from "./code-editor.js";

type ViewMode = "tree" | "code";

export function JsonViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    parseError = e instanceof Error ? e.message : "Invalid JSON";
  }

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
              onClick={() => setViewMode("tree")}
              className={`px-2 py-1 rounded-l ${
                viewMode === "tree"
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              }`}
            >
              Tree
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
          <CodeEditor content={content} language="json" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 font-mono text-sm">
          {parseError !== null ? (
            <div>
              <div className="mb-2 text-red-500">Parse error: {parseError}</div>
              <pre className="whitespace-pre-wrap text-[var(--color-muted)]">{content}</pre>
            </div>
          ) : (
            <JsonNode value={parsed} />
          )}
        </div>
      )}
    </div>
  );
}

function JsonNode({ value, keyName }: {
  readonly value: unknown;
  readonly keyName?: string;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  if (value === null) {
    return (
      <span>
        {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
        <span className="text-[var(--color-muted)]">null</span>
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span>
        {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
        <span className="text-yellow-600">{String(value)}</span>
      </span>
    );
  }

  if (typeof value === "number") {
    return (
      <span>
        {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
        <span className="text-blue-500">{String(value)}</span>
      </span>
    );
  }

  if (typeof value === "string") {
    return (
      <span>
        {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
        <span className="text-green-600">"{value}"</span>
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <span>
          {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
          {"[]"}
        </span>
      );
    }

    return (
      <div>
        <button type="button" onClick={() => setCollapsed(!collapsed)} className="inline-flex items-center gap-0.5">
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
          {"["}
          {collapsed && <span className="text-[var(--color-muted)]"> {value.length} items ]</span>}
        </button>
        {!collapsed && (
          <div className="ml-4 border-l border-[var(--color-border)] pl-2">
            {value.map((item, i) => (
              <div key={i}>
                <JsonNode value={item} />
                {i < value.length - 1 && ","}
              </div>
            ))}
          </div>
        )}
        {!collapsed && "]"}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <span>
          {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
          {"{}"}
        </span>
      );
    }

    return (
      <div>
        <button type="button" onClick={() => setCollapsed(!collapsed)} className="inline-flex items-center gap-0.5">
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {keyName !== undefined && <span className="text-[var(--color-primary)]">"{keyName}": </span>}
          {"{"}
          {collapsed && <span className="text-[var(--color-muted)]"> {entries.length} keys {"}"}</span>}
        </button>
        {!collapsed && (
          <div className="ml-4 border-l border-[var(--color-border)] pl-2">
            {entries.map(([k, v], i) => (
              <div key={k}>
                <JsonNode value={v} keyName={k} />
                {i < entries.length - 1 && ","}
              </div>
            ))}
          </div>
        )}
        {!collapsed && "}"}
      </div>
    );
  }

  return <span className="text-[var(--color-muted)]">{String(value)}</span>;
}
