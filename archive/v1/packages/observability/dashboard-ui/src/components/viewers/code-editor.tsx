/**
 * CodeEditor — CodeMirror wrapper for syntax-highlighted code display and editing.
 *
 * Supports both read-only viewing and editing. When `editable` is true and
 * `onSave` is provided, shows a save button and tracks content changes.
 */

import { useCallback, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { Save } from "lucide-react";

type Language = "json" | "markdown" | "yaml" | "text";

const LANGUAGE_EXTENSIONS: Readonly<Record<string, () => Extension>> = {
  json,
  markdown,
  yaml,
};

export function CodeEditor({
  content,
  language,
  className,
  editable = false,
  onSave,
}: {
  readonly content: string;
  readonly language?: Language;
  readonly className?: string;
  readonly editable?: boolean;
  readonly onSave?: (content: string) => void;
}): React.ReactElement {
  const [currentContent, setCurrentContent] = useState(content);
  const [hasChanges, setHasChanges] = useState(false);

  const extensions = useMemo((): readonly Extension[] => {
    if (language === undefined || language === "text") {
      return [];
    }
    const factory = LANGUAGE_EXTENSIONS[language];
    if (factory === undefined) {
      return [];
    }
    return [factory()];
  }, [language]);

  const handleChange = useCallback(
    (value: string) => {
      setCurrentContent(value);
      setHasChanges(value !== content);
    },
    [content],
  );

  const handleSave = useCallback(() => {
    if (onSave !== undefined && hasChanges) {
      onSave(currentContent);
      setHasChanges(false);
    }
  }, [onSave, hasChanges, currentContent]);

  const isEditable = editable && onSave !== undefined;

  return (
    <div className="relative flex flex-col h-full">
      {/* @ts-expect-error — React 19 JSX type mismatch with library's React 18 declarations (same as ReactFlow) */}
      <CodeMirror
        value={content}
        editable={isEditable}
        readOnly={!isEditable}
        onChange={isEditable ? handleChange : undefined}
        extensions={[...extensions]}
        theme="dark"
        className={className}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: isEditable,
        }}
      />
      {isEditable && hasChanges && (
        <div className="sticky bottom-0 flex justify-end border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      )}
    </div>
  );
}
