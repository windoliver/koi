/**
 * DispatchDialog — modal form for creating/dispatching a new agent.
 *
 * Collects agent name (required), manifest (optional), and initial
 * message (optional). Calls dispatchAgent API on submit.
 */

import { memo, useCallback, useState } from "react";
import { dispatchAgent } from "../../lib/api-client.js";

export interface DispatchDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDispatched: (agentId: string) => void;
}

export const DispatchDialog = memo(function DispatchDialog({
  open,
  onClose,
  onDispatched,
}: DispatchDialogProps): React.ReactElement | null {
  const [name, setName] = useState("");
  const [manifest, setManifest] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setName("");
    setManifest("");
    setMessage("");
    setError(null);
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setError("Agent name is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const trimmedManifest = manifest.trim();
      const trimmedMessage = message.trim();
      const result = await dispatchAgent({
        name: trimmedName,
        ...(trimmedManifest !== "" ? { manifest: trimmedManifest } : {}),
        ...(trimmedMessage !== "" ? { message: trimmedMessage } : {}),
      });
      resetForm();
      onDispatched(result.agentId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to dispatch agent");
      setSubmitting(false);
    }
  }, [name, manifest, message, resetForm, onDispatched]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    },
    [handleClose],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={handleClose}
        role="presentation"
      />

      {/* Dialog */}
      <div
        className="relative z-10 w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispatch-dialog-title"
      >
        <h2
          id="dispatch-dialog-title"
          className="text-lg font-semibold text-[var(--color-foreground)]"
        >
          Dispatch New Agent
        </h2>

        <div className="mt-4 space-y-4">
          {/* Name (required) */}
          <div>
            <label htmlFor="dispatch-name" className="block text-sm font-medium text-[var(--color-foreground)]">
              Agent Name <span className="text-red-500">*</span>
            </label>
            <input
              id="dispatch-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              disabled={submitting}
              placeholder="my-agent"
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] disabled:opacity-50"
              autoFocus
            />
          </div>

          {/* Manifest (optional) */}
          <div>
            <label htmlFor="dispatch-manifest" className="block text-sm font-medium text-[var(--color-foreground)]">
              Manifest <span className="text-xs text-[var(--color-muted)]">(optional)</span>
            </label>
            <input
              id="dispatch-manifest"
              type="text"
              value={manifest}
              onChange={(e) => { setManifest(e.target.value); }}
              disabled={submitting}
              placeholder="path/to/manifest.yaml"
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] disabled:opacity-50"
            />
          </div>

          {/* Initial message (optional) */}
          <div>
            <label htmlFor="dispatch-message" className="block text-sm font-medium text-[var(--color-foreground)]">
              Initial Message <span className="text-xs text-[var(--color-muted)]">(optional)</span>
            </label>
            <textarea
              id="dispatch-message"
              value={message}
              onChange={(e) => { setMessage(e.target.value); }}
              disabled={submitting}
              placeholder="Tell the agent what to do..."
              rows={3}
              className="mt-1 w-full resize-none rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] disabled:opacity-50"
            />
          </div>

          {/* Error */}
          {error !== null && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-border)]/50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void handleSubmit(); }}
            disabled={submitting || name.trim() === ""}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary)]/90 disabled:opacity-50"
          >
            {submitting ? "Dispatching..." : "Dispatch"}
          </button>
        </div>
      </div>
    </div>
  );
});
