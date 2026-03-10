/**
 * CommandBar — search input for finding files in the Nexus namespace.
 *
 * Debounced search triggers the useSearch hook. Results shown as a dropdown
 * overlay that navigates to the selected file.
 * Scoped to the active saved view's rootPaths and globPattern.
 */

import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FOCUS_SEARCH_EVENT } from "../../hooks/use-keyboard-shortcuts.js";
import { useSearch } from "../../hooks/use-search.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";
import { FileIcon } from "./file-icon.js";

export function CommandBar(): React.ReactElement {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const select = useTreeStore((s) => s.select);
  const expandAll = useTreeStore((s) => s.expandAll);
  const activeView = useViewStore((s) => s.activeView);

  const searchOptions =
    activeView.globPattern !== undefined
      ? { rootPaths: activeView.rootPaths, glob: activeView.globPattern }
      : { rootPaths: activeView.rootPaths };
  const { results, isSearching } = useSearch(query, searchOptions);

  // Listen for global Ctrl/Cmd+K focus event
  useEffect(() => {
    const handleFocusSearch = (): void => {
      inputRef.current?.focus();
    };
    document.addEventListener(FOCUS_SEARCH_EVENT, handleFocusSearch);
    return () => {
      document.removeEventListener(FOCUS_SEARCH_EVENT, handleFocusSearch);
    };
  }, []);

  const handleSelect = (path: string): void => {
    // Expand parent directories so the file is visible in the tree
    const parts = path.split("/").filter((p) => p.length > 0);
    const parentPaths: string[] = [];
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = `${current}/${parts[i]!}`;
      parentPaths.push(current);
    }
    expandAll(parentPaths);
    select(path);
    setQuery("");
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      setQuery("");
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(e.target.value.length >= 2);
          }}
          onFocus={() => {
            if (query.length >= 2) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search files... (Ctrl+K)"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-muted)]"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setIsOpen(false);
            }}
            className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 max-h-64 overflow-y-auto border border-[var(--color-border)] bg-[var(--color-card)] shadow-lg">
          {isSearching && (
            <div className="px-3 py-2 text-xs text-[var(--color-muted)]">
              Searching...
            </div>
          )}
          {!isSearching && results.length === 0 && query.length >= 2 && (
            <div className="px-3 py-2 text-xs text-[var(--color-muted)]">
              No results
            </div>
          )}
          {results.map((result) => (
            <button
              key={result.path}
              type="button"
              onClick={() => handleSelect(result.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-muted)]/10"
            >
              <FileIcon
                name={result.path.split("/").pop() ?? ""}
                isDirectory={false}
              />
              <span className="truncate">{result.path}</span>
              {result.snippet !== undefined && (
                <span className="ml-auto truncate text-xs text-[var(--color-muted)]">
                  {result.snippet}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
