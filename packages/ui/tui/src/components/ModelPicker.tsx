/**
 * ModelPicker — overlay for fuzzy-filtering and switching the active model.
 *
 * The modal state (query, fetched models, loading/error status) lives in
 * the TUI store as the `model-picker` modal variant. This component reads
 * that slice, fuzzy-filters the model list by the current query, and
 * dispatches selection / cancel through the injected callbacks.
 */

import type { JSX } from "solid-js";
import { fuzzyFilter } from "../commands/fuzzy-match.js";
import type { ModelEntry } from "../state/types.js";
import { useTuiStore } from "../store-context.js";
import { COLORS, MODAL_POSITION } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPickerProps {
  /** Called when the user selects a model (Enter). */
  readonly onSelect: (model: ModelEntry) => void;
  /** Called when the user dismisses (Escape). */
  readonly onClose: () => void;
  /** Whether this overlay currently has keyboard focus. */
  readonly focused: boolean;
}

interface ResolvedModal {
  readonly query: string;
  readonly status: "loading" | "ready" | "error";
  readonly models: readonly ModelEntry[];
  readonly error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for test)
// ---------------------------------------------------------------------------

/** Fuzzy-filter models by id; empty query returns all. */
export function filterModels(
  models: readonly ModelEntry[],
  query: string,
): readonly ModelEntry[] {
  return fuzzyFilter(models, query, (m) => m.id);
}

/**
 * Render a single model entry as a one-line label:
 *   "openai/gpt-5"
 *   "anthropic/claude-opus-4-7  ·  200k ctx"
 *   "anthropic/claude-opus-4-7  ·  200k ctx  ·  $15/$75 per 1M"
 */
export function formatModelRow(m: ModelEntry): string {
  const parts: string[] = [m.id];
  if (m.contextLength !== undefined) {
    parts.push(`${Math.round(m.contextLength / 1000)}k ctx`);
  }
  if (m.pricingIn !== undefined && m.pricingOut !== undefined) {
    const inM = Math.round(m.pricingIn * 1_000_000);
    const outM = Math.round(m.pricingOut * 1_000_000);
    parts.push(`$${inM}/$${outM} per 1M`);
  }
  return parts.join("  ·  ");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const modal = useTuiStore((s) => s.modal);
  const currentModel = useTuiStore((s) => s.modelName);

  const resolveModal = (): ResolvedModal => {
    const m = modal();
    if (m?.kind !== "model-picker") {
      return { query: "", status: "loading", models: [] };
    }
    return m;
  };

  const getModelLabel = (m: ModelEntry): string =>
    m.id === currentModel() ? `* ${formatModelRow(m)}` : formatModelRow(m);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.purple}
      width={90}
      {...MODAL_POSITION}
    >
      {/* Header */}
      <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.purple}>
          <b>{"Models"}</b>
        </text>
        <text fg={COLORS.textMuted}>{" — select to switch, Esc to cancel"}</text>
      </box>

      {resolveModal().status === "loading" ? (
        <text fg={COLORS.textMuted}>{"  loading…"}</text>
      ) : resolveModal().status === "error" ? (
        <box flexDirection="column" paddingLeft={1}>
          <text fg={COLORS.red}>{resolveModal().error ?? "Failed to fetch models"}</text>
          <text fg={COLORS.textMuted}>{"Edit KOI_MODEL in .env to switch manually."}</text>
        </box>
      ) : (
        <SelectOverlay
          items={filterModels(resolveModal().models, resolveModal().query)}
          getLabel={getModelLabel}
          onSelect={props.onSelect}
          onClose={props.onClose}
          focused={props.focused}
          emptyText="No models matched"
        />
      )}
    </box>
  );
}
