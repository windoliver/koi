/**
 * CodeEditor — read-only CodeMirror wrapper for syntax-highlighted code display.
 */

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";

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
}: {
  readonly content: string;
  readonly language?: Language;
  readonly className?: string;
}): React.ReactElement {
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

  return (
    // @ts-expect-error — React 19 JSX type mismatch with library's React 18 declarations (same as ReactFlow)
    <CodeMirror
      value={content}
      editable={false}
      readOnly={true}
      extensions={[...extensions]}
      theme="dark"
      className={className}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: false,
      }}
    />
  );
}
