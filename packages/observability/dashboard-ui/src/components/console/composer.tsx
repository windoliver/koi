/**
 * Composer — chat input with send button.
 *
 * Submit on Enter, Shift+Enter for newline.
 * Disabled during streaming. Rejects empty input.
 */

import { Send, Square } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";

export interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  readonly isStreaming: boolean;
  readonly disabled?: boolean;
}

export const Composer = memo(function Composer({
  onSend,
  onCancel,
  isStreaming,
  disabled = false,
}: ComposerProps): React.ReactElement {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed === "" || isStreaming) return;
    onSend(trimmed);
    setText("");
    // Refocus after send
    textareaRef.current?.focus();
  }, [text, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="border-t border-[var(--color-border)] p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={isStreaming ? "Waiting for response..." : "Send a message..."}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20"
            title="Cancel"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled || text.trim() === ""}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90 disabled:opacity-50"
            title="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
});
