/**
 * TextViewer — renders plain text content with line numbers.
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function TextViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const lines = content.split("\n");

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
    </div>
  );
}
