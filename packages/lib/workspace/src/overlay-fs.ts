import type {
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileRenameResult,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";

export interface OverlayFileSystemConfig {
  readonly real: FileSystemBackend;
  readonly overlay: FileSystemBackend;
}

function fileNotFoundError(path: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `File not found: ${path}`,
    retryable: false,
  };
}

function computeDryRunEdit(
  path: string,
  content: string,
  edits: readonly FileEdit[],
): FileEditResult {
  let text = content;
  let applied = 0;
  for (const edit of edits) {
    if (!text.includes(edit.oldText)) continue;
    text = text.replace(edit.oldText, edit.newText);
    applied++;
  }
  return { path, hunksApplied: applied };
}

class OverlayFileSystemBackend implements FileSystemBackend {
  readonly name: string;
  private readonly tombstones = new Set<string>();
  private readonly overlayPaths = new Set<string>();
  private readonly real: FileSystemBackend;
  private readonly overlay: FileSystemBackend;

  constructor(config: OverlayFileSystemConfig) {
    this.real = config.real;
    this.overlay = config.overlay;
    this.name = `${config.overlay.name}-overlay`;
    if (config.overlay.delete !== undefined) {
      this.delete = this.deleteOverlayPath;
      this.rename = this.renameOverlayPath;
    }
  }

  private isMaskedRealPath(path: string): boolean {
    return this.tombstones.has(path) || this.overlayPaths.has(path);
  }

  async read(path: string, options?: FileReadOptions): Promise<Result<FileReadResult, KoiError>> {
    if (this.tombstones.has(path)) return { ok: false, error: fileNotFoundError(path) };
    const overlayResult = await this.overlay.read(path, options);
    if (overlayResult.ok || overlayResult.error.code !== "NOT_FOUND") return overlayResult;
    return this.real.read(path, options);
  }

  async write(
    path: string,
    content: string,
    options?: FileWriteOptions,
  ): Promise<Result<FileWriteResult, KoiError>> {
    this.tombstones.delete(path);
    const written = await this.overlay.write(path, content, options);
    if (written.ok) this.overlayPaths.add(path);
    return written;
  }

  async edit(
    path: string,
    edits: readonly FileEdit[],
    options?: FileEditOptions,
  ): Promise<Result<FileEditResult, KoiError>> {
    if (!this.tombstones.has(path)) {
      const overlayAttempt = await this.overlay.edit(path, edits, options);
      if (overlayAttempt.ok) {
        if (options?.dryRun !== true) this.overlayPaths.add(path);
        return overlayAttempt;
      }
      if (overlayAttempt.error.code !== "NOT_FOUND") return overlayAttempt;
    }
    if (options?.dryRun === true) return this.dryRunEdit(path, edits);
    const hydrated = await this.hydrateForEdit(path);
    if (!hydrated.ok) return hydrated;
    const edited = await this.overlay.edit(path, edits, options);
    if (edited.ok) this.overlayPaths.add(path);
    return edited;
  }

  async list(path: string, options?: FileListOptions): Promise<Result<FileListResult, KoiError>> {
    const [realList, overlayList] = await Promise.all([
      this.real.list(path, options),
      this.overlay.list(path, options),
    ]);
    if (!realList.ok && realList.error.code !== "NOT_FOUND") return realList;
    if (!overlayList.ok && overlayList.error.code !== "NOT_FOUND") return overlayList;
    const entries = new Map(
      (realList.ok ? realList.value.entries : [])
        .filter((entry) => !this.isMaskedRealPath(entry.path))
        .map((entry) => [entry.path, entry]),
    );
    for (const entry of overlayList.ok ? overlayList.value.entries : []) {
      if (!this.tombstones.has(entry.path)) entries.set(entry.path, entry);
    }
    return {
      ok: true,
      value: {
        entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
        truncated: this.mergedTruncated(realList, overlayList),
      },
    };
  }

  async search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    const [realSearch, overlaySearch] = await Promise.all([
      this.real.search(pattern, options),
      this.overlay.search(pattern, options),
    ]);
    if (!realSearch.ok && realSearch.error.code !== "NOT_FOUND") return realSearch;
    if (!overlaySearch.ok && overlaySearch.error.code !== "NOT_FOUND") return overlaySearch;
    return {
      ok: true,
      value: {
        matches: this.mergedMatches(realSearch, overlaySearch),
        truncated: this.mergedTruncated(realSearch, overlaySearch),
      },
    };
  }

  async dispose(): Promise<void> {
    await this.overlay.dispose?.();
  }

  readonly delete?: (path: string) => Promise<Result<{ readonly path: string }, KoiError>>;
  readonly rename?: (from: string, to: string) => Promise<Result<FileRenameResult, KoiError>>;

  private async dryRunEdit(
    path: string,
    edits: readonly FileEdit[],
  ): Promise<Result<FileEditResult, KoiError>> {
    const existing = await this.read(path);
    if (!existing.ok) return existing;
    return { ok: true, value: computeDryRunEdit(path, existing.value.content, edits) };
  }

  private async hydrateForEdit(path: string): Promise<Result<void, KoiError>> {
    const existing = await this.read(path);
    if (!existing.ok) return existing;
    const written = await this.overlay.write(path, existing.value.content, {
      createDirectories: true,
    });
    if (!written.ok) return written;
    this.tombstones.delete(path);
    return { ok: true, value: undefined };
  }

  private mergedMatches(
    realSearch: Result<FileSearchResult, KoiError>,
    overlaySearch: Result<FileSearchResult, KoiError>,
  ): FileSearchResult["matches"] {
    return [
      ...(realSearch.ok
        ? realSearch.value.matches.filter((match) => !this.isMaskedRealPath(match.path))
        : []),
      ...(overlaySearch.ok
        ? overlaySearch.value.matches.filter((match) => !this.tombstones.has(match.path))
        : []),
    ].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  private mergedTruncated(
    left: Result<{ readonly truncated: boolean }, KoiError>,
    right: Result<{ readonly truncated: boolean }, KoiError>,
  ): boolean {
    return (left.ok ? left.value.truncated : false) || (right.ok ? right.value.truncated : false);
  }

  private deleteOverlayPath = async (
    path: string,
  ): Promise<Result<{ readonly path: string }, KoiError>> => {
    this.tombstones.add(path);
    this.overlayPaths.delete(path);
    const deleted = await this.overlay.delete?.(path);
    if (deleted === undefined || deleted.ok || deleted.error.code === "NOT_FOUND") {
      return { ok: true, value: { path } };
    }
    return deleted;
  };

  private renameOverlayPath = async (
    from: string,
    to: string,
  ): Promise<Result<FileRenameResult, KoiError>> => {
    const source = await this.read(from);
    if (!source.ok) return source;
    const written = await this.overlay.write(to, source.value.content, { createDirectories: true });
    if (!written.ok) return written;
    const deleted = await this.overlay.delete?.(from);
    if (deleted !== undefined && !deleted.ok && deleted.error.code !== "NOT_FOUND") {
      return deleted;
    }
    this.tombstones.delete(to);
    this.tombstones.add(from);
    this.overlayPaths.add(to);
    this.overlayPaths.delete(from);
    return { ok: true, value: { from, to } };
  };
}

export function createOverlayFileSystem(config: OverlayFileSystemConfig): FileSystemBackend {
  return new OverlayFileSystemBackend(config);
}
