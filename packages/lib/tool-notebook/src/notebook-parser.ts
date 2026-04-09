/**
 * Pure .ipynb JSON parsing, serialization, and cell construction.
 *
 * nbformat 4 structure:
 * {
 *   "nbformat": 4,
 *   "nbformat_minor": 5,
 *   "metadata": { "kernelspec": { ... }, "language_info": { ... } },
 *   "cells": [
 *     {
 *       "cell_type": "code" | "markdown" | "raw",
 *       "id": "abc123",
 *       "metadata": {},
 *       "source": string | string[],  // array of lines in nbformat 4
 *       "outputs": [...],             // only for code cells
 *       "execution_count": null | number
 *     }
 *   ]
 * }
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export type CellType = "code" | "markdown" | "raw";

export interface NotebookCell {
  readonly cell_type: CellType;
  /** Present for nbformat >= 4.5 only. Older notebooks omit cell IDs. */
  readonly id?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly source: string | readonly string[];
  readonly outputs?: readonly unknown[];
  readonly execution_count?: number | null;
}

export interface Notebook {
  readonly nbformat: number;
  readonly nbformat_minor: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly cells: readonly NotebookCell[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCellType(value: unknown): value is CellType {
  return value === "code" || value === "markdown" || value === "raw";
}

function isStringOrStringArray(value: unknown): value is string | string[] {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return false;
}

function parseCell(raw: unknown, index: number): Result<NotebookCell> {
  if (!isRecord(raw)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Cell at index ${index} is not an object`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  const cellType = raw.cell_type;
  if (!isCellType(cellType)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Cell at index ${index} has invalid cell_type: ${String(cellType)}`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  // id is optional: only required for nbformat >= 4.5. Older notebooks omit it.
  const id = raw.id;
  const cellId: string | undefined = typeof id === "string" ? id : undefined;

  const source = raw.source;
  if (!isStringOrStringArray(source)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Cell at index ${index} has invalid source field`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const outputs = Array.isArray(raw.outputs) ? (raw.outputs as readonly unknown[]) : undefined;
  const execCount = raw.execution_count;
  const execution_count =
    execCount === null || execCount === undefined
      ? null
      : typeof execCount === "number"
        ? execCount
        : null;

  const cell: NotebookCell = {
    cell_type: cellType,
    ...(cellId !== undefined && { id: cellId }),
    metadata,
    source,
    ...(outputs !== undefined && { outputs }),
    ...(execution_count !== undefined && { execution_count }),
  };

  return { ok: true, value: cell };
}

/**
 * Parse .ipynb JSON text into a typed Notebook.
 * Validates nbformat >= 4 and that cells is an array.
 */
export function parseNotebook(text: string): Result<Notebook> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  if (!isRecord(parsed)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: "Notebook root is not an object",
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  const nbformat = parsed.nbformat;
  if (typeof nbformat !== "number" || nbformat < 4) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Unsupported nbformat: ${String(nbformat)}. Only nbformat >= 4 is supported.`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  if (!Array.isArray(parsed.cells)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: 'Notebook is missing required "cells" array',
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
    return { ok: false, error };
  }

  const cells: NotebookCell[] = [];
  for (let i = 0; i < parsed.cells.length; i++) {
    const cellResult = parseCell(parsed.cells[i], i);
    if (!cellResult.ok) return cellResult;
    cells.push(cellResult.value);
  }

  const nbformat_minor = typeof parsed.nbformat_minor === "number" ? parsed.nbformat_minor : 5;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};

  const notebook: Notebook = {
    nbformat,
    nbformat_minor,
    metadata,
    cells,
  };

  return { ok: true, value: notebook };
}

/**
 * Serialize a Notebook back to pretty-printed JSON (1-space indent).
 * Converts normalized string sources back to line arrays for nbformat 4.
 */
export function serializeNotebook(nb: Notebook): string {
  const rawCells = nb.cells.map((cell) => {
    const base: Record<string, unknown> = {
      cell_type: cell.cell_type,
      // Only serialize id if present — older notebooks (nbformat < 4.5) omit it
      ...(cell.id !== undefined && { id: cell.id }),
      metadata: cell.metadata,
      source: sourceToArray(normalizeSource(cell.source)),
    };
    if (cell.cell_type === "code") {
      base.outputs = cell.outputs ?? [];
      base.execution_count = cell.execution_count ?? null;
    }
    return base;
  });

  return JSON.stringify(
    {
      nbformat: nb.nbformat,
      nbformat_minor: nb.nbformat_minor,
      metadata: nb.metadata,
      cells: rawCells,
    },
    null,
    1,
  );
}

/**
 * Normalize source: join array of lines to a single string, or pass through.
 */
export function normalizeSource(source: string | readonly string[]): string {
  if (typeof source === "string") return source;
  return source.join("");
}

/**
 * Split a string into a line array for nbformat 4 storage.
 * Each line except the last retains its trailing newline.
 */
export function sourceToArray(source: string): readonly string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i < lines.length - 1) {
      result.push(`${line}\n`);
    } else if (line !== "") {
      result.push(line);
    }
  }
  return result;
}

/**
 * Generate a random 8-character hex cell ID.
 */
function generateCellId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a new NotebookCell.
 * Cell IDs are only assigned for nbformat >= 4.5 (introduced in that version).
 * Older notebooks don't use IDs and adding one would corrupt the format.
 */
export function createCell(
  type: CellType,
  source: string,
  nbformat: number,
  nbformatMinor: number,
): NotebookCell {
  const assignId = nbformat > 4 || (nbformat === 4 && nbformatMinor >= 5);
  const base = {
    cell_type: type,
    ...(assignId && { id: generateCellId() }),
    metadata: {} as Readonly<Record<string, unknown>>,
    source: sourceToArray(source),
  };
  if (type === "code") {
    return { ...base, outputs: [], execution_count: null };
  }
  return base;
}
